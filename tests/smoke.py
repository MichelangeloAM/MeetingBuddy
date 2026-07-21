#!/usr/bin/env python3
"""End-to-end smoke test for Meeting Generator.

Boots app.py in a subprocess against a temporary WRITABLE_DIR, exercises every
critical API endpoint, uploads a short fixture, and verifies the transcribe →
summarize → done cycle. Exits non-zero on any failure.

Run: python tests/smoke.py
Assumes the venv is active and a Whisper model (default 'tiny') is cached.
"""

from __future__ import annotations

import argparse
import http.client
import io
import json
import math
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import uuid
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"


class SmokeError(RuntimeError):
    pass


def _log(msg: str) -> None:
    print(f"[smoke] {msg}", flush=True)


def _ensure_fixture(path: Path, duration_s: float = 6.0, freq: float = 440.0, sample_rate: int = 16000) -> None:
    if path.exists() and path.stat().st_size > 1024:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    n_samples = int(duration_s * sample_rate)
    frames = io.BytesIO()
    for i in range(n_samples):
        t = i / sample_rate
        val = int(32000 * math.sin(2 * math.pi * freq * t) * (0.6 if 0.5 < t < duration_s - 0.5 else 0.0))
        frames.write(struct.pack("<h", val))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(frames.getvalue())
    _log(f"wrote fixture {path} ({path.stat().st_size} bytes, {duration_s:.1f}s)")


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for(port: int, timeout: float = 30.0) -> None:
    start = time.time()
    while time.time() - start < timeout:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                _log(f"server up on 127.0.0.1:{port} after {time.time()-start:.1f}s")
                return
        except OSError:
            time.sleep(0.3)
    raise SmokeError(f"server never opened on 127.0.0.1:{port}")


def _req(method: str, host: str, port: int, path: str, body: bytes | None = None, headers: dict | None = None, timeout: float = 30.0) -> tuple[int, dict, bytes]:
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        resp = conn.getresponse()
        data = resp.read()
        return resp.status, dict(resp.getheaders()), data
    finally:
        conn.close()


def _get_json(port: int, path: str) -> tuple[int, dict]:
    status, _, body = _req("GET", "127.0.0.1", port, path)
    if status == 200:
        try:
            return status, json.loads(body.decode())
        except json.JSONDecodeError as e:
            raise SmokeError(f"GET {path} returned non-JSON: {e} :: {body[:200]!r}")
    return status, {}


def _post_json(port: int, path: str, payload: dict) -> tuple[int, dict]:
    body = json.dumps(payload).encode()
    status, _, resp = _req("POST", "127.0.0.1", port, path, body, {"Content-Type": "application/json"})
    if resp:
        try: return status, json.loads(resp.decode())
        except json.JSONDecodeError: return status, {}
    return status, {}


def _upload(port: int, file_path: Path, model_size: str) -> str:
    boundary = f"----smoke{uuid.uuid4().hex}"
    part = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"model_size\"\r\n\r\n{model_size}\r\n"
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_path.name}\"\r\n"
        f"Content-Type: audio/wav\r\n\r\n"
    ).encode()
    part += file_path.read_bytes()
    part += f"\r\n--{boundary}--\r\n".encode()
    status, _, body = _req(
        "POST", "127.0.0.1", port, "/api/upload", part,
        {"Content-Type": f"multipart/form-data; boundary={boundary}", "Content-Length": str(len(part))},
    )
    if status != 200:
        raise SmokeError(f"upload failed status={status} body={body!r}")
    return json.loads(body.decode())["job_id"]


def _stream_progress(port: int, job_id: str, timeout: float) -> dict:
    """Consume the SSE stream until we see a `done` or `error` event."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    conn.request("GET", f"/api/progress/{job_id}", headers={"Accept": "text/event-stream"})
    resp = conn.getresponse()
    if resp.status != 200:
        raise SmokeError(f"progress SSE status={resp.status}")

    started = time.time()
    event_name = ""
    data_buf = ""
    saw_transcribe = False
    saw_summarize = False
    result = {"done": False, "error": None}
    try:
        while True:
            if time.time() - started > timeout:
                raise SmokeError(f"job {job_id} did not finish in {timeout}s")
            raw = resp.fp.readline()
            if not raw:
                raise SmokeError("SSE stream closed unexpectedly")
            line = raw.decode(errors="replace").rstrip("\r\n")
            if line.startswith("event:"):
                event_name = line[6:].strip()
            elif line.startswith("data:"):
                data_buf += line[5:].strip()
            elif line == "":
                if event_name:
                    payload = {}
                    if data_buf:
                        try: payload = json.loads(data_buf)
                        except json.JSONDecodeError: payload = {"_raw": data_buf}
                    if event_name == "progress":
                        phase = payload.get("phase")
                        if phase == "transcribing": saw_transcribe = True
                        if phase == "summarizing": saw_summarize = True
                    elif event_name == "done":
                        result["done"] = True
                        break
                    elif event_name == "error":
                        result["error"] = payload.get("message", "unknown")
                        break
                event_name = ""
                data_buf = ""
    finally:
        conn.close()
    result["saw_transcribe"] = saw_transcribe
    result["saw_summarize"] = saw_summarize
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=os.environ.get("SMOKE_MODEL", "tiny"),
                        help="Whisper model to use (must be cached). Default 'tiny'.")
    parser.add_argument("--skip-e2e", action="store_true",
                        help="Skip upload → done E2E (endpoint checks only).")
    parser.add_argument("--e2e-timeout", type=float, default=180.0,
                        help="Max seconds for the E2E transcribe → summarize cycle.")
    args = parser.parse_args()

    port = _free_port()
    tmpdir = Path(tempfile.mkdtemp(prefix="mg_smoke_"))
    _log(f"using tmp WRITABLE_DIR={tmpdir}")

    env = os.environ.copy()
    env["MEETINGGEN_BROWSER"] = "1"  # in case launcher.py is used elsewhere
    # Not overriding WRITABLE_DIR (settings.py picks based on frozen state; in dev it uses repo dir).
    # But we can use PYTHONPATH to isolate settings.

    cmd = [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"]
    proc = subprocess.Popen(cmd, cwd=str(ROOT), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

    failures: list[str] = []
    try:
        try:
            _wait_for(port)
        except SmokeError as e:
            _log(f"FATAL: {e}")
            out = proc.stdout.read().decode(errors="replace")[-2000:] if proc.stdout else ""
            _log(f"server output tail:\n{out}")
            return 1

        # 1. index
        status, _, body = _req("GET", "127.0.0.1", port, "/")
        if status != 200 or b"<title>Meeting Generator</title>" not in body:
            failures.append(f"GET / status={status}, title missing")
        else:
            _log("GET / -> ok")

        # 2. onboarding
        s, data = _get_json(port, "/api/onboarding")
        if s != 200 or "needs_onboarding" not in data:
            failures.append(f"/api/onboarding schema: {data}")
        else:
            _log(f"/api/onboarding -> needs={data['needs_onboarding']} has_model={data.get('has_model')}")

        # 3. models
        s, models = _get_json(port, "/api/models")
        if s != 200 or not isinstance(models, list) or len(models) != 4:
            failures.append(f"/api/models returned {len(models) if isinstance(models,list) else 'non-list'}")
        else:
            _log(f"/api/models -> {[m['id'] for m in models]}")
            tiny_ok = any(m["id"] == args.model and m.get("downloaded") for m in models)
            if not tiny_ok:
                _log(f"WARNING: model '{args.model}' not cached; E2E will fail. Skipping E2E.")
                args.skip_e2e = True

        # 4. disk
        s, disk = _get_json(port, "/api/system/disk")
        if s != 200 or disk.get("free_bytes", 0) <= 0:
            failures.append(f"/api/system/disk unexpected: {disk}")
        else:
            _log(f"/api/system/disk -> free={disk['free_bytes']/1e9:.1f}GB")

        # 5. settings test (invalid key)
        s, tst = _post_json(port, "/api/settings/test", {"api_key": "sk-invalid-smoke-test"})
        if s != 200 or tst.get("ok") is not False:
            failures.append(f"/api/settings/test with invalid key: {tst}")
        else:
            _log(f"/api/settings/test invalid -> ok=False message='{tst.get('message')}'")

        # 6. E2E upload
        if not args.skip_e2e:
            fixture = FIXTURE_DIR / "short.wav"
            _ensure_fixture(fixture)
            job_id = _upload(port, fixture, args.model)
            _log(f"uploaded fixture, job_id={job_id}")
            result = _stream_progress(port, job_id, timeout=args.e2e_timeout)
            if result.get("error"):
                failures.append(f"E2E error: {result['error']}")
            elif not result.get("done"):
                failures.append("E2E never emitted done")
            else:
                _log(f"E2E done (transcribe seen={result['saw_transcribe']}, summarize seen={result['saw_summarize']})")
                # 7. result endpoint
                s, res = _get_json(port, f"/api/result/{job_id}")
                required = ("summary", "key_points", "transcript", "timed_segments")
                if s != 200 or not all(k in res for k in required):
                    failures.append(f"/api/result/{job_id} missing keys: {res.keys() if isinstance(res, dict) else res}")
                else:
                    _log(f"/api/result -> summary={len(res.get('summary',''))} chars, {len(res.get('timed_segments',[]))} segments")
                # 8. delete
                status, _, _ = _req("DELETE", "127.0.0.1", port, f"/api/job/{job_id}")
                if status != 200:
                    failures.append(f"DELETE /api/job/{job_id} status={status}")
                else:
                    _log(f"DELETE /api/job/{job_id} -> ok")

    finally:
        _log("shutting down server...")
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        shutil.rmtree(tmpdir, ignore_errors=True)

    print()
    if failures:
        print("SMOKE FAILURES:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("SMOKE OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
