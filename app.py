import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from jinja2 import Environment, FileSystemLoader
from sse_starlette.sse import EventSourceResponse

from generator import generate_pdf, generate_text
from model_manager import (
    cancel_download,
    delete_model,
    download_model_sync,
    get_disk_usage,
    get_progress,
    is_model_cached,
    list_models,
    sync_cache_to_settings,
)
from models import JobStatus, MeetingNotes
from summarizer import generate_meeting_notes, test_connection
from transcriber import get_transcriber, Segment
from settings import BUNDLE_DIR, WRITABLE_DIR, load_settings, save_settings

load_dotenv()

BASE_DIR = BUNDLE_DIR
DATA_DIR = WRITABLE_DIR

(DATA_DIR / "outputs").mkdir(exist_ok=True)

app = FastAPI(title="Meeting Generator")


@app.on_event("startup")
async def _startup():
    await asyncio.to_thread(sync_cache_to_settings)
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")

_env = Environment(loader=FileSystemLoader(str(BASE_DIR / "templates")), auto_reload=False, cache_size=0)

HISTORY_FILE = str(DATA_DIR / "outputs" / "history.json")
MAX_HISTORY = 50

jobs: dict[str, dict] = {}
model_download_queues: dict[str, asyncio.Queue] = {}

_JOB_ID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_JOB_MAX_IDLE_SECONDS = 3600  # 1 hour after completion, memory record is trimmed
_MAX_BUFFERED_EVENTS = 2000  # bounded event history so long jobs don't blow up memory

_LANGUAGE_WHITELIST = {
    "en", "it", "es", "fr", "de", "pt", "nl", "ru", "zh", "ja", "ko", "ar",
    "hi", "tr", "pl", "sv", "no", "fi", "da", "cs", "uk", "ro", "el", "hu",
    "he", "id", "th", "vi", "ms", "ca",
}


def _valid_job_id(job_id: str) -> bool:
    return bool(_JOB_ID_RE.match(job_id or ""))


def _prune_jobs() -> None:
    now = time.time()
    stale = []
    for jid, job in jobs.items():
        finished_at = job.get("_finished_at")
        if finished_at and now - finished_at > _JOB_MAX_IDLE_SECONDS:
            stale.append(jid)
    for jid in stale:
        jobs.pop(jid, None)


def _publish(job: dict, event_type: str, data: dict | None = None) -> None:
    """Append an event to a job's buffered history and broadcast to live subscribers.

    Safe to call from the event loop thread. From worker threads use
    `_publish_from_thread` so the queue put happens on the event loop.
    """
    payload = (event_type, data or {})
    events: list = job.setdefault("events", [])
    events.append(payload)
    if len(events) > _MAX_BUFFERED_EVENTS:
        del events[: len(events) - _MAX_BUFFERED_EVENTS]
    if event_type in ("done", "error", "cancelled"):
        job["_terminal"] = True
    subs: set = job.get("subscribers") or set()
    for q in list(subs):
        try:
            q.put_nowait(payload)
        except Exception:
            pass


def _publish_from_thread(loop: asyncio.AbstractEventLoop, job: dict, event_type: str, data: dict | None = None) -> None:
    asyncio.run_coroutine_threadsafe(
        _publish_async(job, event_type, data), loop,
    )


async def _publish_async(job: dict, event_type: str, data: dict | None = None) -> None:
    _publish(job, event_type, data)


def _load_history() -> list[dict]:
    try:
        with open(HISTORY_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save_job_to_history(job: dict) -> None:
    history = _load_history()
    entry = {
        "id": job["id"],
        "filename": job["filename"],
        "model_size": job.get("model_size", "large-v3"),
        "audio_duration": job.get("audio_duration", 0),
        "word_count": job.get("word_count", 0),
        "processing_time": job.get("processing_time", 0),
        "created_at": job.get("created_at", ""),
        "status": job["status"],
    }
    history = [e for e in history if e["id"] != entry["id"]]
    history.insert(0, entry)
    history = history[:MAX_HISTORY]
    with open(HISTORY_FILE, "w") as f:
        json.dump(history, f, indent=2)


def _load_job_result(job_id: str) -> dict | None:
    result_path = DATA_DIR / "outputs" / f"{job_id}_result.json"
    try:
        with open(result_path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    template = _env.get_template("index.html")
    return HTMLResponse(template.render())


@app.get("/api/settings")
async def get_settings():
    s = load_settings()
    # never leak the raw api key beyond a masked hint
    key = s.get("api_key", "") or ""
    return JSONResponse({
        **s,
        "api_key": key,
        "api_key_present": bool(key.strip()),
    })


@app.post("/api/settings")
async def update_settings(request: Request):
    body = await request.json()
    settings = load_settings()
    for key in ("api_key", "onboarding_completed", "permissions_acknowledged"):
        if key in body:
            settings[key] = body[key]
    save_settings(settings)
    return JSONResponse({"ok": True})


@app.post("/api/settings/test")
async def settings_test(request: Request):
    body = await request.json()
    api_key = body.get("api_key") or ""
    ok, message, latency_ms = await asyncio.to_thread(test_connection, api_key)
    return JSONResponse({
        "ok": ok,
        "message": message,
        "latency_ms": round(latency_ms, 1) if latency_ms is not None else None,
    })


@app.get("/api/onboarding")
async def onboarding_status():
    s = load_settings()
    has_key = bool((s.get("api_key") or "").strip())
    downloaded = s.get("downloaded_models") or []
    on_disk = [m["id"] for m in list_models() if m.get("downloaded")]
    has_model = bool(downloaded or on_disk)
    completed = bool(s.get("onboarding_completed"))
    return JSONResponse({
        "needs_onboarding": not completed,
        "onboarding_completed": completed,
        "has_api_key": has_key,
        "has_model": has_model,
        "permissions_acknowledged": bool(s.get("permissions_acknowledged")),
        "downloaded_models": sorted(set(list(downloaded) + on_disk)),
    })


@app.get("/api/system/disk")
async def system_disk():
    try:
        return JSONResponse(get_disk_usage())
    except OSError as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/api/system/open-settings")
async def open_system_settings(request: Request):
    body = await request.json()
    pane = (body.get("pane") or "").lower()
    try:
        if sys.platform == "darwin":
            urls = {
                "microphone": "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
                "screen-recording": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
                "screen-capture": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            }
            url = urls.get(pane, "x-apple.systempreferences:com.apple.preference.security")
            subprocess.Popen(["open", url])
        elif sys.platform == "win32":
            urls = {
                "microphone": "ms-settings:privacy-microphone",
                "screen-recording": "ms-settings:privacy-broadfilesystemaccess",
                "screen-capture": "ms-settings:privacy-broadfilesystemaccess",
            }
            url = urls.get(pane, "ms-settings:privacy")
            subprocess.Popen(["cmd", "/c", "start", "", url], shell=False)
        else:
            return JSONResponse({"ok": False, "message": "Unsupported platform"}, status_code=400)
        return JSONResponse({"ok": True})
    except Exception as e:
        return JSONResponse({"ok": False, "message": str(e)}, status_code=500)


@app.get("/api/models")
async def get_models():
    return JSONResponse(list_models())


@app.post("/api/models/{model_size}/download")
async def start_model_download(model_size: str):
    if model_size not in ("tiny", "small", "medium", "large-v3"):
        return JSONResponse({"error": "Invalid model size"}, status_code=400)
    if is_model_cached(model_size):
        return JSONResponse({"status": "already_downloaded"})
    model_download_queues[model_size] = asyncio.Queue()
    asyncio.create_task(_run_model_download(model_size))
    return JSONResponse({"status": "downloading", "model_size": model_size})


@app.post("/api/models/{model_size}/cancel")
async def cancel_model_download(model_size: str):
    ok = cancel_download(model_size)
    return JSONResponse({"ok": ok})


@app.delete("/api/models/{model_size}")
async def remove_model(model_size: str):
    ok = delete_model(model_size)
    return JSONResponse({"ok": ok})


@app.get("/api/models/{model_size}/download-progress")
async def model_download_progress(model_size: str, request: Request):
    if model_size not in model_download_queues:
        cached = is_model_cached(model_size)
        return EventSourceResponse(_single_event("done" if cached else "not_found"))

    q = model_download_queues[model_size]

    async def generate():
        while True:
            msg = await q.get()
            if msg is None:
                break
            event_type, data = msg
            yield {"event": event_type, "data": json.dumps(data)}

    return EventSourceResponse(generate())


async def _single_event(event_type: str):
    yield {"event": event_type, "data": json.dumps({"message": "ok"})}


async def _run_model_download(model_size: str):
    q = model_download_queues.get(model_size)
    if not q:
        return

    async def push_progress():
        last_signature = None
        while True:
            await asyncio.sleep(1)
            progress = get_progress(model_size)
            signature = (progress.get("progress"), progress.get("downloaded_mb"))
            if signature != last_signature:
                await q.put(("progress", progress))
                last_signature = signature
            if progress.get("cancelled"):
                await q.put(("cancelled", progress))
                return
            if progress.get("progress", 0) >= 100:
                return

    progress_task = asyncio.create_task(push_progress())

    try:
        await asyncio.to_thread(download_model_sync, model_size)
    except Exception as e:
        await q.put(("error", {"message": str(e)}))
    else:
        await q.put(("done", {"message": f"Model {model_size} ready!"}))
    finally:
        progress_task.cancel()
        try:
            await progress_task
        except asyncio.CancelledError:
            pass
        await q.put(None)


_ALLOWED_AUDIO_EXT = {
    ".mp3", ".wav", ".m4a", ".flac", ".ogg", ".opus", ".webm",
    ".mp4", ".aac", ".oga", ".wma", ".aiff", ".aif",
}


@app.post("/api/upload")
async def upload_audio(
    file: UploadFile,
    model_size: str = Form("large-v3"),
    language: str = Form(""),
):
    job_id = str(uuid.uuid4())
    raw_name = Path(file.filename or "").name  # strip any path components
    ext = Path(raw_name).suffix.lower()
    if ext not in _ALLOWED_AUDIO_EXT:
        ext = ".bin"
    file_path = str(DATA_DIR / "outputs" / f"{job_id}{ext}")

    lang = (language or "").strip().lower()
    if lang and lang not in _LANGUAGE_WHITELIST:
        lang = ""

    content = await file.read()
    with open(file_path, "wb") as f:
        f.write(content)

    jobs[job_id] = {
        "id": job_id,
        "status": JobStatus.QUEUED.value,
        "progress": 0.0,
        "message": "Queued",
        "filename": raw_name or f"upload{ext}",
        "file_size": len(content),
        "model_size": model_size,
        "language": lang,
        "audio_duration": 0.0,
        "word_count": 0,
        "processing_time": 0.0,
        "created_at": datetime.now().isoformat(),
        "result": None,
        "error": None,
        "events": [],
        "subscribers": set(),
        "cancel_event": threading.Event(),
        "_file_path": file_path,
    }

    asyncio.create_task(_process_job(job_id, file_path, raw_name or f"upload{ext}", model_size, lang))

    return JSONResponse({"job_id": job_id})


@app.get("/api/jobs")
async def list_jobs():
    return JSONResponse(_load_history())


@app.get("/api/jobs/active")
async def list_active_jobs():
    """Any job that is still in-flight (queued/transcribing/summarizing).

    Used by the frontend to restore a 'return to processing' pill if the page
    reloads mid-job.
    """
    active = []
    for jid, job in jobs.items():
        if job.get("_terminal"):
            continue
        status = job.get("status")
        if status in (
            JobStatus.QUEUED.value,
            JobStatus.TRANSCRIBING.value,
            JobStatus.SUMMARIZING.value,
        ):
            active.append({
                "id": jid,
                "status": status,
                "filename": job.get("filename"),
                "model_size": job.get("model_size"),
                "language": job.get("language", ""),
                "progress": job.get("progress", 0.0),
                "message": job.get("message", ""),
                "audio_duration": job.get("audio_duration", 0),
                "created_at": job.get("created_at", ""),
            })
    return JSONResponse(active)


@app.post("/api/job/{job_id}/cancel")
async def cancel_job(job_id: str):
    if not _valid_job_id(job_id):
        return JSONResponse({"error": "Invalid job id"}, status_code=400)
    job = jobs.get(job_id)
    if job is None:
        return JSONResponse({"error": "Job not found"}, status_code=404)
    if job.get("_terminal"):
        return JSONResponse({"ok": True, "already_terminal": True})

    ev: threading.Event | None = job.get("cancel_event")
    if ev is not None:
        ev.set()
    job["status"] = JobStatus.CANCELLED.value
    job["message"] = "Cancelling…"
    _publish(job, "progress", {
        "phase": job.get("_current_phase", "transcribing"),
        "progress": job.get("progress", 0.0),
        "message": "Cancelling…",
    })
    return JSONResponse({"ok": True})


@app.delete("/api/job/{job_id}")
async def delete_job(job_id: str):
    if not _valid_job_id(job_id):
        return JSONResponse({"error": "Invalid job id"}, status_code=400)

    history = _load_history()
    history = [e for e in history if e["id"] != job_id]
    with open(HISTORY_FILE, "w") as f:
        json.dump(history, f, indent=2)

    if job_id in jobs:
        del jobs[job_id]

    outputs_dir = (DATA_DIR / "outputs").resolve()
    for f in outputs_dir.glob(f"{job_id}*"):
        try:
            # Defense-in-depth: refuse to unlink anything outside outputs_dir
            resolved = f.resolve()
            if outputs_dir in resolved.parents:
                resolved.unlink(missing_ok=True)
        except OSError:
            pass
    return JSONResponse({"ok": True})


@app.get("/api/progress/{job_id}")
async def progress_stream(job_id: str, request: Request):
    if not _valid_job_id(job_id):
        return JSONResponse({"error": "Invalid job id"}, status_code=400)

    job = jobs.get(job_id)
    if job is None:
        return JSONResponse({"error": "Job not found"}, status_code=404)

    async def generate():
        # Snapshot current status first so the client can initialize UI state.
        status = job["status"]
        yield {
            "event": "status",
            "data": json.dumps({
                "status": status,
                "progress": job.get("progress", 0.0),
                "message": job.get("message", ""),
                "audio_duration": job.get("audio_duration", 0),
                "language": job.get("language", ""),
            }),
        }

        # Replay any buffered events so a re-connecting client doesn't miss anything.
        for evt, data in list(job.get("events", [])):
            yield {"event": evt, "data": json.dumps(data)}

        if job.get("_terminal"):
            return

        # Subscribe to future events.
        q: asyncio.Queue = asyncio.Queue()
        subs: set = job.setdefault("subscribers", set())
        subs.add(q)
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    # keepalive comment so proxies don't drop the stream
                    yield {"event": "ping", "data": "{}"}
                    continue
                event_type, data = msg
                yield {"event": event_type, "data": json.dumps(data)}
                if event_type in ("done", "error", "cancelled"):
                    break
        finally:
            subs.discard(q)

    return EventSourceResponse(generate())


def _rehydrate_notes(cached: dict) -> MeetingNotes:
    """Rebuild a MeetingNotes from a cached _result.json blob."""
    return MeetingNotes(
        summary=cached.get("summary", "") or "",
        key_points=list(cached.get("key_points") or []),
        action_items=list(cached.get("action_items") or []),
        decisions=list(cached.get("decisions") or []),
        topics=list(cached.get("topics") or []),
        transcript=cached.get("transcript", "") or "",
        segments=[
            Segment(start=s.get("start", 0.0), end=s.get("end", 0.0), text=s.get("text", ""))
            for s in (cached.get("timed_segments") or [])
        ],
    )


def _get_result_for_export(job_id: str) -> MeetingNotes | None:
    """Return a MeetingNotes for the given job, from live memory or cached JSON."""
    job = jobs.get(job_id)
    if job and job.get("status") == JobStatus.DONE.value and job.get("result") is not None:
        return job["result"]
    cached = _load_job_result(job_id)
    if cached:
        return _rehydrate_notes(cached)
    return None


@app.get("/api/result/{job_id}")
async def get_result(job_id: str):
    if not _valid_job_id(job_id):
        return JSONResponse({"error": "Invalid job id"}, status_code=400)
    job = jobs.get(job_id)
    if not job:
        cached = _load_job_result(job_id)
        if cached:
            return JSONResponse(cached)
        return JSONResponse({"error": "Job not found"}, status_code=404)

    if job["status"] != JobStatus.DONE.value:
        return JSONResponse(
            {"error": "Processing not complete", "status": job["status"]},
            status_code=400,
        )

    notes: MeetingNotes = job["result"]
    result = {
        "summary": notes.summary,
        "key_points": notes.key_points,
        "action_items": notes.action_items,
        "decisions": notes.decisions,
        "topics": notes.topics,
        "transcript": notes.transcript,
        "timed_segments": [
            {"start": s.start, "end": s.end, "text": s.text}
            for s in notes.segments
        ],
        "audio_duration": job.get("audio_duration", 0),
        "word_count": job.get("word_count", 0),
        "processing_time": job.get("processing_time", 0),
        "metadata": {
            "filename": job["filename"],
            "file_size": job.get("file_size", 0),
            "model_size": job.get("model_size", "large-v3"),
            "language": job.get("language", "") or job.get("detected_language", ""),
            "created_at": job.get("created_at", ""),
        },
    }

    result_path = str(DATA_DIR / "outputs" / f"{job_id}_result.json")
    try:
        with open(result_path, "w") as f:
            json.dump(result, f)
    except OSError:
        pass

    return JSONResponse(result)


@app.get("/api/result/{job_id}/pdf")
async def download_pdf(job_id: str):
    if not _valid_job_id(job_id):
        return JSONResponse({"error": "Invalid job id"}, status_code=400)
    notes = _get_result_for_export(job_id)
    if notes is None:
        return JSONResponse({"error": "Result not found"}, status_code=404)

    pdf_bytes = generate_pdf(notes)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": "attachment; filename=meeting_notes.pdf",
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.get("/api/result/{job_id}/text")
async def download_text(job_id: str):
    if not _valid_job_id(job_id):
        return JSONResponse({"error": "Invalid job id"}, status_code=400)
    notes = _get_result_for_export(job_id)
    if notes is None:
        return JSONResponse({"error": "Result not found"}, status_code=404)

    text = generate_text(notes)
    return Response(
        content=text,
        media_type="text/plain; charset=utf-8",
        headers={
            "Content-Disposition": "attachment; filename=meeting_notes.txt",
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.get("/api/result/{job_id}/markdown")
async def download_markdown(job_id: str):
    if not _valid_job_id(job_id):
        return JSONResponse({"error": "Invalid job id"}, status_code=400)
    notes = _get_result_for_export(job_id)
    if notes is None:
        return JSONResponse({"error": "Result not found"}, status_code=404)

    md = f"""# Meeting Notes

## Summary
{notes.summary}

## Key Discussion Points
{chr(10).join(f'- {p}' for p in notes.key_points)}

## Action Items
{chr(10).join(f'- [ ] {a}' for a in notes.action_items)}

## Decisions Made
{chr(10).join(f'- {d}' for d in notes.decisions)}

## Topics Covered
{chr(10).join(f'- {t}' for t in notes.topics)}

---

## Full Transcript
{notes.transcript}
"""
    return Response(
        content=md,
        media_type="text/markdown; charset=utf-8",
        headers={
            "Content-Disposition": "attachment; filename=meeting_notes.md",
            "X-Content-Type-Options": "nosniff",
        },
    )


async def _process_job(
    job_id: str,
    file_path: str,
    filename: str,
    model_size: str = "large-v3",
    language: str = "",
):
    job = jobs[job_id]
    loop = asyncio.get_running_loop()
    start_time = time.time()
    summarize_start: dict[str, float] = {}
    cancel_ev: threading.Event = job.get("cancel_event") or threading.Event()

    def _is_cancelled() -> bool:
        return cancel_ev.is_set()

    def _thread_progress(pct: float, msg: str):
        if _is_cancelled():
            return
        job["progress"] = pct
        job["message"] = msg
        elapsed = time.time() - start_time
        _publish_from_thread(loop, job, "progress", {
            "phase": "transcribing",
            "progress": pct,
            "message": msg,
            "elapsed_seconds": round(elapsed, 1),
            "audio_duration": job.get("audio_duration", 0),
        })

    def _thread_segment(segment: Segment):
        if _is_cancelled():
            return
        _publish_from_thread(loop, job, "segment", {
            "text": segment.text,
            "start": segment.start,
            "end": segment.end,
        })

    def _thread_language(lang: str):
        job["detected_language"] = lang
        _publish_from_thread(loop, job, "language_detected", {"language": lang})

    def _thread_summary_progress(pct: float, msg: str):
        if _is_cancelled():
            return
        elapsed_summ = time.time() - summarize_start.get("t", time.time())
        _publish_from_thread(loop, job, "progress", {
            "phase": "summarizing",
            "progress": pct,
            "message": msg,
            "elapsed_seconds": round(elapsed_summ, 1),
        })

    async def _progress(pct: float, msg: str, phase: str = "transcribing"):
        job["progress"] = pct
        job["message"] = msg
        elapsed = time.time() - start_time
        _publish(job, "progress", {
            "phase": phase,
            "progress": pct,
            "message": msg,
            "elapsed_seconds": round(elapsed, 1),
            "audio_duration": job.get("audio_duration", 0),
        })

    async def _phase(phase_name: str):
        job["_current_phase"] = phase_name
        _publish(job, "phase", {"phase": phase_name})

    async def _done():
        _publish(job, "done", {"message": "Processing complete"})

    async def _error(msg: str):
        _publish(job, "error", {"message": msg})

    async def _cancelled(reason: str = "Cancelled by user"):
        job["status"] = JobStatus.CANCELLED.value
        job["message"] = reason
        _publish(job, "cancelled", {"message": reason})

    async def _check_cancel_and_maybe_exit() -> bool:
        if _is_cancelled():
            await _cancelled()
            job["_finished_at"] = time.time()
            _prune_jobs()
            return True
        return False

    try:
        if not os.path.exists(file_path):
            await _error(f"Audio file not found at {file_path}. Please re-upload.")
            return

        if await _check_cancel_and_maybe_exit():
            return

        cached = is_model_cached(model_size)
        transcriber = get_transcriber(model_size=model_size)

        if not cached:
            await _phase("downloading_model")
            await _progress(0, f"Downloading {model_size} model…", phase="downloading_model")

            async def _poll_dl():
                last_pct = -1
                while True:
                    await asyncio.sleep(1)
                    p = get_progress(model_size)
                    pct = p.get("progress", 0)
                    if pct != last_pct:
                        await _progress(pct, p.get("message", f"Downloading {model_size}…"), phase="downloading_model")
                        last_pct = pct
                    if pct >= 100:
                        break

            dl_poll = asyncio.create_task(_poll_dl())
            try:
                await asyncio.to_thread(download_model_sync, model_size)
            except Exception as e:
                dl_poll.cancel()
                try:
                    await dl_poll
                except asyncio.CancelledError:
                    pass
                await _error(f"Model download failed: {e}")
                return
            else:
                dl_poll.cancel()
                try:
                    await dl_poll
                except asyncio.CancelledError:
                    pass

            if await _check_cancel_and_maybe_exit():
                return

            if not is_model_cached(model_size):
                await _error("Model download completed but files not found. Please try again in Settings.")
                return

            await _progress(100, "Model download complete", phase="downloading_model")

        job["status"] = JobStatus.TRANSCRIBING.value
        await _phase("loading_model")
        await _progress(0, "Loading transcription model…")

        await _phase("transcribing")
        segments, audio_duration = await asyncio.to_thread(
            transcriber.transcribe_sync,
            file_path,
            _thread_progress,
            _thread_segment,
            language or None,
            _is_cancelled,
            _thread_language,
        )

        if await _check_cancel_and_maybe_exit():
            return

        transcript_text = transcriber.segments_to_text(segments)
        job["audio_duration"] = round(audio_duration, 1)

        # Mark transcribe fully complete.
        await _progress(100.0, "Transcription complete", phase="transcribing")

        job["status"] = JobStatus.SUMMARIZING.value
        await _phase("summarizing")
        summarize_start["t"] = time.time()
        await _progress(0, "Analyzing meeting with AI…", phase="summarizing")

        try:
            notes = await asyncio.to_thread(
                generate_meeting_notes, transcript_text, _thread_summary_progress, _is_cancelled,
            )
        except TypeError:
            # Backwards-compat: older summarizer.generate_meeting_notes without cancel_check.
            notes = await asyncio.to_thread(
                generate_meeting_notes, transcript_text, _thread_summary_progress,
            )

        if await _check_cancel_and_maybe_exit():
            return

        notes.transcript = transcript_text
        notes.segments = segments

        processing_time = round(time.time() - start_time, 1)
        word_count = len(transcript_text.split())

        job["status"] = JobStatus.DONE.value
        job["progress"] = 100.0
        job["result"] = notes
        job["message"] = "Complete"
        job["word_count"] = word_count
        job["processing_time"] = processing_time

        await _progress(100.0, "Summary ready", phase="summarizing")
        job["_finished_at"] = time.time()
        _save_job_to_history(job)
        _prune_jobs()

        await _done()

    except Exception as e:
        job["status"] = JobStatus.ERROR.value
        msg = str(e)
        lo = msg.lower()
        if "onnxruntime" in lo or "ctranslate2" in lo:
            msg = "Model load failed. The cached model may be corrupt — delete it in Settings and re-download. (" + msg + ")"
        elif "no such file" in lo:
            msg = "Audio file not found. Please re-upload. (" + msg + ")"
        job["error"] = msg
        job["message"] = "Error: " + msg
        job["_finished_at"] = time.time()
        _save_job_to_history(job)
        _prune_jobs()
        await _error(msg)
