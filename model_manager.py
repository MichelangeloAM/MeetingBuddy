import os
import shutil
import sys
import threading
import time

from settings import load_settings, set_setting

MODEL_INFO: dict[str, dict] = {
    "tiny": {
        "size_mb": 75,
        "label": "tiny (~75 MB)",
        "description": "Fastest, lowest accuracy. Good for quick tests and short clips.",
        "recommended_for": "Testing",
    },
    "small": {
        "size_mb": 500,
        "label": "small (~500 MB)",
        "description": "Recommended default. ~5× realtime on Apple Silicon with good accuracy.",
        "recommended_for": "Recommended",
    },
    "medium": {
        "size_mb": 1500,
        "label": "medium (~1.5 GB)",
        "description": "Better accuracy on long meetings and accents. Slower than small.",
        "recommended_for": "Higher accuracy",
    },
    "large-v3": {
        "size_mb": 3000,
        "label": "large-v3 (~3 GB)",
        "description": "Best accuracy. Slowest to run; needs ~8 GB free RAM.",
        "recommended_for": "Best quality",
    },
    "large-v3-q4": {
        "size_mb": 800,
        "label": "large-v3-q4 (~800 MB)",
        "description": "4-bit quantized large-v3. Good accuracy with 4× less RAM. Apple Silicon only.",
        "recommended_for": "Quantized (macOS)",
    },
    "large-v3-q8": {
        "size_mb": 1500,
        "label": "large-v3-q8 (~1.5 GB)",
        "description": "8-bit quantized large-v3. Near-full accuracy at half RAM. Apple Silicon only.",
        "recommended_for": "Quantized (macOS)",
    },
}

_download_progress: dict[str, dict] = {}
_cancel_events: dict[str, threading.Event] = {}


def _use_mlx(model_size: str) -> bool:
    """Whether this model is (or would be) served by the MLX backend.

    Quantized models only exist as MLX repos. For standard sizes, the cache
    check/download must target whatever repo the active backend will actually
    load at transcribe time — otherwise we cache-check/download the faster-whisper
    repo while MLX silently pulls its own mlx-community repo on first use.
    """
    if model_size in ("large-v3-q4", "large-v3-q8"):
        return True
    from transcriber import _get_backend
    return _get_backend() == "mlx"


def _get_repo_id(model_size: str) -> str:
    if model_size == "large-v3-q4":
        return "mlx-community/whisper-large-v3-turbo-4bit"
    if model_size == "large-v3-q8":
        return "mlx-community/whisper-large-v3-turbo-8bit"
    if _use_mlx(model_size):
        from transcriber import MLXWhisperTranscriber
        return MLXWhisperTranscriber._MODEL_MAP.get(model_size, f"mlx-community/whisper-{model_size}-mlx")
    return f"Systran/faster-whisper-{model_size}"


def _get_cache_dir() -> str:
    try:
        from huggingface_hub.constants import HF_HUB_CACHE
        return HF_HUB_CACHE
    except ImportError:
        return os.path.join(os.path.expanduser("~"), ".cache", "huggingface")


def _model_dir(model_size: str) -> str:
    repo_id = _get_repo_id(model_size)
    return os.path.join(_get_cache_dir(), f"models--{repo_id.replace('/', '--')}")


def is_model_cached(model_size: str) -> bool:
    model_dir = _model_dir(model_size)
    if not os.path.isdir(model_dir):
        return False
    for root, _dirs, files in os.walk(model_dir):
        for f in files:
            if f.endswith((".bin", ".onnx", ".json")):
                return True
    return False


def _get_cache_size_mb(model_size: str) -> float:
    model_dir = _model_dir(model_size)
    if not os.path.isdir(model_dir):
        return 0.0
    total = 0
    for root, _dirs, files in os.walk(model_dir):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total / (1024 * 1024)


def get_model_status(model_size: str) -> dict:
    info = dict(MODEL_INFO.get(model_size, {"size_mb": 0, "label": model_size}))
    info["id"] = model_size
    info["downloaded"] = is_model_cached(model_size)
    info["downloading"] = model_size in _download_progress and _download_progress[model_size].get("progress", 0) < 100
    if info["downloaded"]:
        info["exact_size_mb"] = round(_get_cache_size_mb(model_size), 1)
    progress = _download_progress.get(model_size, {})
    info["download_progress"] = progress.get("progress", 0)
    info["download_message"] = progress.get("message", "")
    info["downloaded_mb"] = progress.get("downloaded_mb", 0)
    info["total_mb"] = progress.get("total_mb", info["size_mb"])
    info["speed_kbps"] = progress.get("speed_kbps", 0)
    info["eta_sec"] = progress.get("eta_sec", 0)
    info["cancelled"] = progress.get("cancelled", False)
    return info


def list_models() -> list[dict]:
    return [get_model_status(m) for m in MODEL_INFO]


def sync_cache_to_settings() -> None:
    """Reconcile settings.downloaded_models with what's actually on disk."""
    settings = load_settings()
    known = set(settings.get("downloaded_models", []))
    on_disk = {m for m in MODEL_INFO if is_model_cached(m)}
    if known != on_disk:
        set_setting("downloaded_models", sorted(on_disk))


def cancel_download(model_size: str) -> bool:
    ev = _cancel_events.get(model_size)
    if ev is None:
        return False
    ev.set()
    p = _download_progress.get(model_size, {})
    p["cancelled"] = True
    p["message"] = "Cancelled — the download may still complete in the background and will resume next time."
    _download_progress[model_size] = p
    return True


def delete_model(model_size: str) -> bool:
    if model_size in _cancel_events:
        return False
    md = _model_dir(model_size)
    if os.path.isdir(md):
        shutil.rmtree(md, ignore_errors=True)
    settings = load_settings()
    downloaded = [m for m in settings.get("downloaded_models", []) if m != model_size]
    set_setting("downloaded_models", downloaded)
    _download_progress.pop(model_size, None)
    return True


def get_disk_usage() -> dict:
    path = _get_cache_dir()
    os.makedirs(path, exist_ok=True)
    total, used, free = shutil.disk_usage(path)
    return {
        "path": path,
        "free_bytes": free,
        "total_bytes": total,
        "used_bytes": used,
    }


class DownloadCancelled(Exception):
    pass


def download_model_sync(model_size: str) -> None:
    if model_size in ("large-v3-q4", "large-v3-q8") and sys.platform != "darwin":
        raise RuntimeError(f"{model_size} is only available on macOS with MLX backend.")

    use_mlx = _use_mlx(model_size)
    if use_mlx:
        try:
            from huggingface_hub import snapshot_download
        except ImportError:
            raise RuntimeError("huggingface_hub not installed. Required to download MLX models.")
        repo_id = _get_repo_id(model_size)

        def _download():
            snapshot_download(repo_id=repo_id)
    else:
        from faster_whisper.utils import download_model

        def _download():
            download_model(model_size)

    cancel_ev = threading.Event()
    _cancel_events[model_size] = cancel_ev
    _download_progress[model_size] = {
        "progress": 0,
        "message": f"Preparing download of {model_size}…",
        "downloaded_mb": 0,
        "total_mb": MODEL_INFO.get(model_size, {}).get("size_mb", 1000),
        "speed_kbps": 0,
        "eta_sec": 0,
        "cancelled": False,
    }

    stop_event = threading.Event()
    expected_mb = MODEL_INFO.get(model_size, {}).get("size_mb", 1000)
    last_mb = 0.0
    last_time = time.time()

    def monitor():
        nonlocal last_mb, last_time
        while not stop_event.is_set():
            if cancel_ev.is_set():
                # Mark cancellation visibly in the progress dict.
                p = dict(_download_progress.get(model_size, {}))
                p["cancelled"] = True
                p["message"] = "Cancelled — partial data cached; download will resume next time."
                _download_progress[model_size] = p
                break
            time.sleep(1.0)
            mb = _get_cache_size_mb(model_size)
            now = time.time()
            dt = max(0.01, now - last_time)
            dmb = max(0.0, mb - last_mb)
            speed_kbps = (dmb * 1024) / dt  # KB/s
            pct = min(95.0, round((mb / expected_mb) * 100, 1)) if expected_mb > 0 else 0
            remaining_mb = max(0.0, expected_mb - mb)
            eta_sec = int(remaining_mb * 1024 / speed_kbps) if speed_kbps > 5 else 0
            _download_progress[model_size] = {
                "progress": pct,
                "message": f"Downloading {model_size}… ({mb:.0f}/{expected_mb} MB)",
                "downloaded_mb": round(mb, 1),
                "total_mb": expected_mb,
                "speed_kbps": round(speed_kbps, 1),
                "eta_sec": eta_sec,
                "cancelled": False,
            }
            last_mb = mb
            last_time = now

    monitor_thread = threading.Thread(target=monitor, daemon=True)
    monitor_thread.start()

    cancelled = False
    try:
        _download()
    finally:
        stop_event.set()
        monitor_thread.join(timeout=5)
        cancelled = cancel_ev.is_set()
        _cancel_events.pop(model_size, None)

    if cancelled:
        # Reflect cancel in the final state but leave partial cache in place so it can resume.
        final_mb = _get_cache_size_mb(model_size)
        _download_progress[model_size] = {
            "progress": min(99, int((final_mb / expected_mb) * 100)) if expected_mb else 0,
            "message": "Cancelled by user. Partial data kept; will resume next time.",
            "downloaded_mb": round(final_mb, 1),
            "total_mb": expected_mb,
            "speed_kbps": 0,
            "eta_sec": 0,
            "cancelled": True,
        }
        raise DownloadCancelled("Download cancelled by user")

    final_mb = _get_cache_size_mb(model_size)
    _download_progress[model_size] = {
        "progress": 100,
        "message": f"Model {model_size} ready ({final_mb:.0f} MB on disk)",
        "downloaded_mb": round(final_mb, 1),
        "total_mb": expected_mb,
        "speed_kbps": 0,
        "eta_sec": 0,
        "cancelled": False,
    }

    settings = load_settings()
    downloaded = set(settings.get("downloaded_models", []))
    downloaded.add(model_size)
    set_setting("downloaded_models", sorted(downloaded))


def get_progress(model_size: str) -> dict:
    return _download_progress.get(model_size, {"progress": 0, "message": ""})
