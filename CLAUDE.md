# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Setup & Run

- Python 3.14 in `.venv`: `source .venv/bin/activate`
- Install deps: `pip install -r requirements.txt`
- Copy `.env.example` to `.env` and fill in `DEEPSEEK_API_KEY`
- Dev server: `uvicorn app:app --host 127.0.0.1 --port 8765` → open http://127.0.0.1:8765

The API key can alternatively be set at runtime through the in-app Settings panel (persisted to `outputs/settings.json`), which takes precedence over the env var lookup — see `settings.get_api_key`.

## Build (desktop distribution)

- macOS: `./build_macos.sh` → produces `dist/MeetingGenerator.app` and `.dmg` via PyInstaller (`app_macos.spec`) + `create_dmg.sh`
- Windows: `build_windows.bat` → uses `app.spec` and optionally `installer_windows.nsi` (NSIS)

The frozen app entrypoint is `launcher.py`, which starts uvicorn in a background thread on 127.0.0.1:8765 and opens a `pywebview` native window (falls back to the default browser if `pywebview` isn't installed).

No test suite is configured.

## Environment variables

- `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` (default `https://api.deepseek.com`)
- `WHISPER_BACKEND` — `mlx` or `faster-whisper`. If unset, `mlx` is preferred when available, else `faster-whisper`
- `WHISPER_MODEL` (default `large-v3`), `COMPUTE_TYPE` (`auto`), `WHISPER_BEAM_SIZE` (`1`), `WHISPER_VAD_FILTER` (`true`) — only apply to the faster-whisper backend

## Architecture

The system is a single-process FastAPI app that runs a three-stage job pipeline (transcribe → summarize → format) and streams progress to the browser via SSE.

**Request flow** (`app.py`):
1. `POST /api/upload` writes the file to `outputs/{job_id}{ext}`, creates an in-memory `jobs[job_id]` record + `asyncio.Queue`, and spawns `_process_job` as a task. Returns the job id immediately.
2. `_process_job` runs the transcriber in a thread (`asyncio.to_thread`) with two callbacks bridged back to the event loop via `run_coroutine_threadsafe` — `_thread_progress` for percentage updates and `_thread_segment` for streaming individual transcript segments to the client as they land.
3. After transcription, `generate_meeting_notes` calls DeepSeek (OpenAI-compatible client, `summarizer.py`) and the parsed `MeetingNotes` is stored on the job record.
4. `GET /api/progress/{job_id}` opens an SSE stream that first replays the current status, then drains the job queue emitting `phase`/`progress`/`segment`/`done`/`error` events. Terminal `None` closes the stream.
5. `GET /api/result/{job_id}` returns the assembled result JSON and side-effect-writes `outputs/{job_id}_result.json` so it survives process restart (jobs dict is memory-only, but history + result JSON are on disk).

**Whisper backend selection** (`transcriber.py`): `_get_backend()` picks between `MLXWhisperTranscriber` (Apple Silicon via `mlx-whisper`, models pulled from `mlx-community/*` HF repos, mapped in `_MODEL_MAP`) and `FasterWhisperTranscriber` (CTranslate2, models pulled from `Systran/faster-whisper-*`). Instances are cached per `backend_model_size` key. The two backends have different progress semantics — MLX only emits progress *after* the full transcription returns since `mlx_whisper.transcribe` is blocking and non-streaming.

**Model manager** (`model_manager.py`): Only the faster-whisper repos are exposed for user download (`MODEL_INFO`). `download_model_sync` shells out to `faster_whisper.utils.download_model` and monitors download progress by polling the HF cache dir size on a background thread — the underlying downloader doesn't emit progress. `is_model_cached` looks for the `models--Systran--faster-whisper-*` dir under the HF cache. MLX models are downloaded lazily by `mlx_whisper` on first use and are not managed here.

**Settings & data dirs** (`settings.py`): `BUNDLE_DIR` = read-only frozen resources (templates/static from PyInstaller `sys._MEIPASS`); `WRITABLE_DIR` = per-user data path. When frozen and the exe dir is not writable, `WRITABLE_DIR` falls back to `~/Library/Application Support/MeetingGenerator` (macOS), `%APPDATA%\MeetingGenerator` (Windows), or `$XDG_DATA_HOME/MeetingGenerator` (Linux). `outputs/`, `settings.json`, and `history.json` all live under `WRITABLE_DIR`. Any new file writes must use `WRITABLE_DIR`; any bundled resource reads must use `BUNDLE_DIR`.

**History**: `outputs/history.json` is a capped list (`MAX_HISTORY = 50`) of completed/errored jobs. `_save_job_to_history` de-dupes by id and prepends; `DELETE /api/job/{id}` prunes both memory and any `{id}*` files in `outputs/`.

**Summarizer contract** (`summarizer.py` + `prompts.py`): The prompt asks DeepSeek for `##SUMMARY`, `##KEY_POINTS`, `##ACTION_ITEMS`, `##DECISIONS`, `##TOPICS` sections with `- ` bullets. `_parse_response` is a hand-rolled state-machine parser — it tolerates spaces vs underscores in headers and filters placeholder items like `none`, `n/a`. If you change section names in `prompts.py`, update the parser to match.

**Frontend**: single-page app at `templates/index.html` with `static/{app.js, recorder.js, style.css, tokens.css, ui.js, wizard.js, permissions.js}`. `tokens.css` holds the design tokens (imported by `style.css`). `ui.js` exposes `window.UI = {toast, modal, confirm, banner, emptyState, badge, progressBar}` — the app uses these instead of `alert()`. `permissions.js` exposes `window.Permissions` for mic + system-audio probes. `wizard.js` is the first-run onboarding flow (fired from `App.init` when `/api/onboarding` returns `needs_onboarding: true`). `recorder.js` handles in-browser audio capture; `app.js` drives upload → SSE → result rendering.

**Two-phase progress**: `_process_job` in `app.py` emits phase-tagged progress events (`phase: "transcribing"` or `"summarizing"`). `summarizer.generate_meeting_notes` takes a `progress_callback` and streams tokens from DeepSeek to emit real progress (falls back to a timer-thread when streaming fails). The frontend routes to two distinct progress cards.

**Model management extras**: `model_manager.py` now tracks download speed/ETA per poll, supports soft cancel (`cancel_download`) and full delete (`delete_model`). `GET /api/system/disk` returns free space on the HF cache disk. `sync_cache_to_settings()` (called at startup) reconciles `settings.downloaded_models` with what's actually on disk.

**Launcher hardening**: `launcher.py` picks a free ephemeral port (tries 8765..8785 first), writes it to `WRITABLE_DIR/runtime_port`, and shows a native OS dialog on startup failure. `webview.events.closed` requests uvicorn shutdown so the process exits cleanly.

**macOS distribution**: `app_macos.spec` reads `CODESIGN_IDENTITY` from the env (defaults to `-` ad-hoc), applies `entitlements.plist` (mic, screen capture, network client/server, JIT, disable-library-validation) and sets the required `NSMicrophoneUsageDescription`, `NSScreenCaptureUsageDescription`, `LSMinimumSystemVersion="11.0"` Info.plist strings. `build_macos.sh` optionally notarizes when `NOTARIZE=1` + `APPLE_ID` + `TEAM_ID` + `APP_PASSWORD` are set. See `build/signing/macos.md`.

**Windows distribution**: `app.manifest` declares `asInvoker` execution, PerMonitorV2 DPI awareness, longPathAware, UTF-8 code page, Win10/11 GUIDs. `version_info.txt` supplies the file/product version resource. `installer_windows.nsi` installs per-user to `%LOCALAPPDATA%\MeetingGenerator\MeetingGenerator` with **no UAC**, writes uninstall metadata to `HKCU`, and bootstraps the Edge WebView2 Runtime via `NSISdl::download` if missing. `build_windows.bat` optionally signs the exe + installer when `SIGN_CERT` + `signtool` are both available. See `build/signing/windows.md`.

**Smoke test**: `tests/smoke.py` spawns uvicorn on a free port, hits `/`, `/api/onboarding`, `/api/models`, `/api/system/disk`, `/api/settings/test`, then uploads a generated sine-wave fixture, streams SSE progress until `done`, and verifies the result endpoint + delete. Use `python tests/smoke.py` (defaults to `--model tiny`; add `--skip-e2e` for the endpoint-only variant).
