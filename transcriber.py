import os
import time
from collections.abc import Callable
from models import Segment

_MLX_AVAILABLE = False
try:
    import mlx_whisper
    _MLX_AVAILABLE = True
except ImportError:
    pass

_FASTER_WHISPER_AVAILABLE = False
try:
    from faster_whisper import WhisperModel as FWModel
    _FASTER_WHISPER_AVAILABLE = True
except ImportError:
    pass


class FasterWhisperTranscriber:
    def __init__(
        self,
        model_size: str = "large-v3",
        compute_type: str = "auto",
        beam_size: int = 1,
        vad_filter: bool = True,
    ):
        self.model_size = model_size
        self.compute_type = compute_type
        self.beam_size = beam_size
        self.vad_filter = vad_filter
        self._model: FWModel | None = None

    @property
    def model(self) -> FWModel:
        if self._model is None:
            device = "auto" if self.compute_type == "auto" else "cuda"
            self._model = FWModel(
                self.model_size,
                device=device,
                compute_type=self.compute_type,
            )
        return self._model

    def transcribe_sync(
        self,
        audio_path: str,
        progress_callback: Callable[[float, str], None] | None = None,
        segment_callback: Callable[[Segment], None] | None = None,
        language: str | None = None,
        cancel_check: Callable[[], bool] | None = None,
        language_callback: Callable[[str], None] | None = None,
    ) -> tuple[list[Segment], float]:
        m = self.model

        if progress_callback:
            progress_callback(0.0, f"Loading audio ({self.model_size})...")

        segments_iter, info = m.transcribe(
            audio_path,
            beam_size=self.beam_size,
            word_timestamps=True,
            condition_on_previous_text=False,
            vad_filter=self.vad_filter,
            vad_parameters=dict(
                threshold=0.5,
                min_silence_duration_ms=500,
                speech_pad_ms=400,
            ),
            language=(language or None),
            task="transcribe",
        )

        duration = info.duration
        detected_language = getattr(info, "language", None)
        if language_callback and detected_language:
            language_callback(detected_language)
        segments: list[Segment] = []

        for seg in segments_iter:
            if cancel_check and cancel_check():
                break
            segment = Segment(start=seg.start, end=seg.end, text=seg.text.strip())
            segments.append(segment)
            if segment_callback:
                segment_callback(segment)
            if progress_callback and duration > 0:
                pct = min(5.0 + (seg.end / duration) * 90.0, 95.0)
                progress_callback(pct, f"Transcribing... ({len(segments)} segments)")

        if progress_callback:
            progress_callback(95.0, "Transcription complete")

        return segments, duration

    def segments_to_text(self, segments: list[Segment]) -> str:
        return "\n".join(s.text for s in segments)


class MLXWhisperTranscriber:
    _MODEL_MAP = {
        "tiny": "mlx-community/whisper-tiny",
        "tiny.en": "mlx-community/whisper-tiny.en-mlx",
        "base": "mlx-community/whisper-base-mlx",
        "base.en": "mlx-community/whisper-base.en-mlx",
        "small": "mlx-community/whisper-small-mlx",
        "small.en": "mlx-community/whisper-small.en-mlx",
        "medium": "mlx-community/whisper-medium-mlx",
        "medium.en": "mlx-community/whisper-medium.en-mlx",
        "large-v3": "mlx-community/whisper-large-v3-turbo",
        "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
        "distil-large-v3": "mlx-community/distil-whisper-large-v3",
    }

    def __init__(self, model_size: str = "large-v3"):
        self.model_size = model_size
        self.hf_repo = self._MODEL_MAP.get(model_size, f"mlx-community/whisper-{model_size}")

    def transcribe_sync(
        self,
        audio_path: str,
        progress_callback: Callable[[float, str], None] | None = None,
        segment_callback: Callable[[Segment], None] | None = None,
        language: str | None = None,
        cancel_check: Callable[[], bool] | None = None,
        language_callback: Callable[[str], None] | None = None,
    ) -> tuple[list[Segment], float]:
        if progress_callback:
            progress_callback(0.0, f"Loading model ({self.model_size})...")

        result = mlx_whisper.transcribe(
            audio_path,
            path_or_hf_repo=self.hf_repo,
            word_timestamps=True,
            language=(language or None),
        )

        raw_segments = result.get("segments", [])
        audio_duration = 0.0

        if raw_segments:
            audio_duration = raw_segments[-1].get("end", 0.0)

        detected_language = result.get("language")
        if language_callback and detected_language:
            language_callback(detected_language)

        segments: list[Segment] = []
        total = len(raw_segments)

        if progress_callback:
            progress_callback(10.0, f"Processing {total} segments...")

        for i, seg in enumerate(raw_segments):
            if cancel_check and cancel_check():
                break
            segment = Segment(
                start=seg["start"],
                end=seg["end"],
                text=seg["text"].strip(),
            )
            segments.append(segment)

            if segment_callback:
                segment_callback(segment)

            if progress_callback and audio_duration > 0:
                pct = min(10.0 + (seg["end"] / audio_duration) * 85.0, 95.0)
                progress_callback(pct, f"Processing... ({i + 1}/{total} segments)")

        if progress_callback:
            progress_callback(95.0, "Transcription complete")

        return segments, audio_duration

    def segments_to_text(self, segments: list[Segment]) -> str:
        return "\n".join(s.text for s in segments)


def _get_backend() -> str:
    backend = os.getenv("WHISPER_BACKEND", "").lower()
    if backend in ("mlx", "metal", "mlx-whisper") and _MLX_AVAILABLE:
        return "mlx"
    if backend in ("faster-whisper", "faster", "ctranslate2") and _FASTER_WHISPER_AVAILABLE:
        return "faster-whisper"
    if _MLX_AVAILABLE:
        return "mlx"
    if _FASTER_WHISPER_AVAILABLE:
        return "faster-whisper"
    raise RuntimeError("No Whisper backend available. Install mlx-whisper or faster-whisper.")


_transcriber_cache: dict[str, FasterWhisperTranscriber | MLXWhisperTranscriber] = {}


def get_transcriber(
    model_size: str | None = None,
    compute_type: str | None = None,
    beam_size: int | None = None,
    vad_filter: bool | None = None,
) -> FasterWhisperTranscriber | MLXWhisperTranscriber:
    ms = model_size or os.getenv("WHISPER_MODEL", "large-v3")
    backend = _get_backend()
    key = f"{backend}_{ms}"

    if key in _transcriber_cache:
        return _transcriber_cache[key]

    if backend == "mlx":
        _transcriber_cache[key] = MLXWhisperTranscriber(model_size=ms)
    else:
        ct = compute_type or os.getenv("COMPUTE_TYPE", "auto")
        bs = beam_size if beam_size is not None else int(os.getenv("WHISPER_BEAM_SIZE", "1"))
        vf = vad_filter if vad_filter is not None else os.getenv("WHISPER_VAD_FILTER", "true").lower() == "true"
        _transcriber_cache[key] = FasterWhisperTranscriber(
            model_size=ms, compute_type=ct, beam_size=bs, vad_filter=vf,
        )

    return _transcriber_cache[key]
