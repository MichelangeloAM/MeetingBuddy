import os
import tempfile
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
    from faster_whisper import BatchedInferencePipeline
    _FASTER_WHISPER_AVAILABLE = True
except ImportError:
    pass

_VAD_AVAILABLE = False
try:
    from faster_whisper.vad import (
        get_speech_timestamps,
        collect_chunks,
        VadOptions,
        SpeechTimestampsMap,
    )
    _VAD_AVAILABLE = True
except ImportError:
    pass

_PSUTIL_AVAILABLE = False
try:
    import psutil
    _PSUTIL_AVAILABLE = True
except ImportError:
    pass


def _detect_cuda() -> bool:
    env_cuda = os.getenv("WHISPER_CUDA", "auto").lower()
    if env_cuda == "force":
        return True
    if env_cuda == "disable":
        return False
    try:
        from ctranslate2 import get_supported_compute_types
        cuda_types = get_supported_compute_types("cuda")
        return len(cuda_types) > 0
    except Exception:
        return False


def _auto_batch_size() -> int:
    env_bs = os.getenv("WHISPER_BATCH_SIZE", "auto").strip()
    if env_bs.isdigit():
        return max(1, int(env_bs))
    if env_bs != "auto" or not _PSUTIL_AVAILABLE:
        return 1
    try:
        available_gb = psutil.virtual_memory().available / (1024 ** 3)
        if available_gb <= 4:
            return 1
        elif available_gb <= 8:
            return 4
        elif available_gb <= 16:
            return 8
        else:
            return 16
    except Exception:
        return 1


class FasterWhisperTranscriber:
    def __init__(
        self,
        model_size: str = "large-v3",
        compute_type: str = "auto",
        beam_size: int = 1,
        vad_filter: bool = True,
        batch_size: int = 1,
        cuda_enabled: str = "auto",
        vad_threshold: float = 0.5,
        vad_min_silence_ms: int = 500,
        vad_speech_pad_ms: int = 400,
    ):
        self.model_size = model_size
        self.beam_size = beam_size
        self.vad_filter = vad_filter
        self.vad_threshold = vad_threshold
        self.vad_min_silence_ms = vad_min_silence_ms
        self.vad_speech_pad_ms = vad_speech_pad_ms
        self._model: FWModel | None = None
        self._batched_model = None

        cuda_available = _detect_cuda()
        if cuda_enabled == "force":
            cuda_available = True
        elif cuda_enabled == "disable":
            cuda_available = False

        if cuda_available:
            self.device = "cuda"
            if compute_type == "auto":
                self.compute_type = "int8_float16"
            else:
                self.compute_type = compute_type
        else:
            self.device = "cpu"
            if compute_type == "auto":
                self.compute_type = "int8"
            else:
                self.compute_type = compute_type

        self.batch_size = batch_size if batch_size >= 1 else _auto_batch_size()
        if self.batch_size > 1 and not _FASTER_WHISPER_AVAILABLE:
            self.batch_size = 1

    @property
    def model(self) -> FWModel:
        if self._model is None:
            self._model = FWModel(
                self.model_size,
                device=self.device,
                compute_type=self.compute_type,
            )
        return self._model

    @property
    def batched_model(self):
        if self.batch_size <= 1:
            return None
        if self._batched_model is None:
            self._batched_model = BatchedInferencePipeline(model=self.model)
        return self._batched_model

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

        transcribe_kwargs = dict(
            beam_size=self.beam_size,
            word_timestamps=False,
            condition_on_previous_text=False,
            vad_filter=self.vad_filter,
            vad_parameters=dict(
                threshold=self.vad_threshold,
                min_silence_duration_ms=self.vad_min_silence_ms,
                speech_pad_ms=self.vad_speech_pad_ms,
            ),
            language=(language or None),
            task="transcribe",
        )

        if self.batched_model is not None:
            transcribe_kwargs["batch_size"] = self.batch_size
            segments_iter, info = self.batched_model.transcribe(
                audio_path, **transcribe_kwargs
            )
        else:
            segments_iter, info = m.transcribe(
                audio_path, **transcribe_kwargs
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
        "large-v3-q4": "mlx-community/whisper-large-v3-turbo-4bit",
        "large-v3-q8": "mlx-community/whisper-large-v3-turbo-8bit",
    }

    def __init__(
        self,
        model_size: str = "large-v3",
        vad_filter: bool = False,
        vad_threshold: float = 0.5,
        vad_min_silence_ms: int = 500,
        vad_speech_pad_ms: int = 400,
    ):
        self.model_size = model_size
        self.hf_repo = self._MODEL_MAP.get(model_size, f"mlx-community/whisper-{model_size}")
        self.vad_filter = vad_filter
        self.vad_threshold = vad_threshold
        self.vad_min_silence_ms = vad_min_silence_ms
        self.vad_speech_pad_ms = vad_speech_pad_ms

    def _apply_vad(self, audio_path: str) -> str:
        if not self.vad_filter or not _VAD_AVAILABLE:
            return audio_path

        try:
            import av
            import numpy as np
            import wave

            vad_params = VadOptions(
                threshold=self.vad_threshold,
                min_silence_duration_ms=self.vad_min_silence_ms,
                speech_pad_ms=self.vad_speech_pad_ms,
            )

            container = av.open(audio_path)
            resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
            frames = []
            for frame in container.decode(audio=0):
                for resampled in resampler.resample(frame):
                    frames.append(resampled.to_ndarray())

            if not frames:
                return audio_path

            audio_np = np.concatenate(frames).astype(np.float32) / 32768.0
            if audio_np.ndim > 1:
                audio_np = audio_np.flatten()

            speech_chunks = get_speech_timestamps(audio_np, vad_params)
            if not speech_chunks:
                return audio_path

            trimmed = np.concatenate(
                [audio_np[chunk["start"]:chunk["end"]] for chunk in speech_chunks]
            )

            fd, tmp_path = tempfile.mkstemp(suffix=".wav")
            os.close(fd)
            trimmed_int16 = (trimmed * 32767).astype(np.int16)
            with wave.open(tmp_path, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(16000)
                wf.writeframes(trimmed_int16.tobytes())
            return tmp_path
        except Exception:
            return audio_path

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

        processed_path = self._apply_vad(audio_path)
        try:
            result = mlx_whisper.transcribe(
                processed_path,
                path_or_hf_repo=self.hf_repo,
                word_timestamps=False,
                language=(language or None),
            )
        finally:
            if processed_path != audio_path:
                try:
                    os.unlink(processed_path)
                except OSError:
                    pass

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
    batch_size: int | None = None,
    cuda_enabled: str | None = None,
    vad_threshold: float | None = None,
    vad_min_silence_ms: int | None = None,
    vad_speech_pad_ms: int | None = None,
) -> FasterWhisperTranscriber | MLXWhisperTranscriber:
    ms = model_size or os.getenv("WHISPER_MODEL", "large-v3")
    backend = _get_backend()

    if backend == "mlx":
        vf = vad_filter if vad_filter is not None else os.getenv("WHISPER_VAD_FILTER", "true").lower() == "true"
        vt = vad_threshold if vad_threshold is not None else float(os.getenv("WHISPER_VAD_THRESHOLD", "0.5"))
        vms = vad_min_silence_ms if vad_min_silence_ms is not None else int(os.getenv("WHISPER_VAD_MIN_SILENCE_MS", "500"))
        vsp = vad_speech_pad_ms if vad_speech_pad_ms is not None else int(os.getenv("WHISPER_VAD_SPEECH_PAD_MS", "400"))
        key = f"{backend}_{ms}_{vf}_{vt}_{vms}_{vsp}"
        if key in _transcriber_cache:
            return _transcriber_cache[key]
        _transcriber_cache[key] = MLXWhisperTranscriber(
            model_size=ms,
            vad_filter=vf,
            vad_threshold=vt,
            vad_min_silence_ms=vms,
            vad_speech_pad_ms=vsp,
        )
    else:
        ct = compute_type or os.getenv("COMPUTE_TYPE", "auto")
        bs = beam_size if beam_size is not None else int(os.getenv("WHISPER_BEAM_SIZE", "1"))
        vf = vad_filter if vad_filter is not None else os.getenv("WHISPER_VAD_FILTER", "true").lower() == "true"
        batch = batch_size if batch_size is not None else _auto_batch_size()
        cu = cuda_enabled or os.getenv("WHISPER_CUDA", "auto")
        vt = vad_threshold if vad_threshold is not None else float(os.getenv("WHISPER_VAD_THRESHOLD", "0.5"))
        vms = vad_min_silence_ms if vad_min_silence_ms is not None else int(os.getenv("WHISPER_VAD_MIN_SILENCE_MS", "500"))
        vsp = vad_speech_pad_ms if vad_speech_pad_ms is not None else int(os.getenv("WHISPER_VAD_SPEECH_PAD_MS", "400"))
        key = f"{backend}_{ms}_{ct}_{bs}_{vf}_{batch}_{cu}_{vt}_{vms}_{vsp}"
        if key in _transcriber_cache:
            return _transcriber_cache[key]
        _transcriber_cache[key] = FasterWhisperTranscriber(
            model_size=ms,
            compute_type=ct,
            beam_size=bs,
            vad_filter=vf,
            batch_size=batch,
            cuda_enabled=cu,
            vad_threshold=vt,
            vad_min_silence_ms=vms,
            vad_speech_pad_ms=vsp,
        )

    return _transcriber_cache[key]
