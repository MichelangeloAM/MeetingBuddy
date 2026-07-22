# Meeting Buddy

Record, transcribe, and summarize meetings locally with AI.

Meeting Buddy captures audio from your microphone or system audio, transcribes it using [Whisper](https://github.com/SYSTRAN/faster-whisper) (runs entirely on your machine), and generates structured meeting notes (summary, key points, action items, decisions, topics) using the [DeepSeek API](https://api.deepseek.com).

---

## Download & Install

Go to the [Releases page](https://github.com/MichelangeloAM/MeetingBuddy/releases) and pick your platform.

### macOS

1. Download `MeetingGenerator.dmg` from the latest release.
2. Double-click the DMG to mount it.
3. Drag `MeetingGenerator.app` into the `Applications` folder.
4. The first time you open it, right-click (or Ctrl+click) the app and choose **Open** (macOS Gatekeeper blocks unsigned apps — this one-time override bypasses it).
5. The app launches a native window. Follow the onboarding wizard.

> [!NOTE]
> The DMG is unsigned. On first launch macOS will show a warning — open Finder, right-click the app, select **Open**, then click **Open** in the dialog.

### Windows

1. Download `MeetingGenerator-Setup.exe` from the latest release.
2. Run the installer — it installs per-user into `%LOCALAPPDATA%`, no admin rights needed.
3. Launch **Meeting Generator** from the Start Menu or desktop shortcut.
4. Follow the onboarding wizard.

---

## Using the App

### 1. First-Time Setup (Onboarding)

When you launch Meeting Buddy for the first time, a 3-step wizard will guide you:

1. **API Key** — paste your [DeepSeek API key](https://platform.deepseek.com/api_keys). Without it, the AI summarization feature won't work. Click **Test Connection** to verify the key is valid.
2. **Download Model** — choose a Whisper model for transcription:
   - `tiny` (~75 MB) — fast, less accurate. Good for testing.
   - `small` (~500 MB) — balanced speed/accuracy.
   - `medium` (~1.5 GB) — good accuracy, moderate speed.
   - `large-v3` (~3 GB) — best accuracy, slowest. Recommended for real meetings.
3. **Permissions** — grant microphone access. On macOS you'll be redirected to System Settings > Privacy > Microphone.

The wizard only appears once. You can change all settings later via the **Settings** panel in the sidebar.

### 2. Recording a Meeting

1. Click **Upload** in the sidebar.
2. Click the large **Record** button (or drag & drop an existing audio file).
   - **Record from Mic:** captures your microphone input.
   - **Record System Audio:** captures computer audio (e.g. Zoom, Teams, Meet). On macOS this requires screen recording permission.
3. Click **Stop** when the meeting ends.
4. The app automatically starts transcribing, then sends the transcript to DeepSeek for summarization.
5. A real-time progress panel shows:
   - Transcription segments appearing live as they're recognized.
   - Download/loading progress for the Whisper model.
   - Summarization progress with elapsed time.

### 3. Viewing Results

Once processing completes, you'll see the **Results** view with several tabs:

- **Summary** — a paragraph condensing the meeting content.
- **Key Points** — bullet list of the most important discussion points.
- **Action Items** — tasks and who they're assigned to.
- **Decisions** — decisions made during the meeting.
- **Topics** — topics that were covered.
- **Transcript** — the full transcription with timestamps for each segment.

### 4. Exporting

Click the export buttons at the top of the Results view:

| Format | File | Description |
|--------|------|-------------|
| **PDF** | `meeting_notes.pdf` | Formatted document with sections |
| **Markdown** | `meeting_notes.md` | Plain markdown, ideal for wikis/notes apps |
| **Text** | `meeting_notes.txt` | Simple plain text |

### 5. History

All past meetings are saved in the **History** panel in the sidebar. Each entry shows:
- Original filename
- Audio duration
- Word count
- Processing time
- Model used
- Status (done / error / cancelled)

Click any history entry to view its full results again or re-export.

### 6. Settings

The **Settings** panel lets you manage:

- **API Key** — add, change, or test your DeepSeek API key.
- **Whisper Model** — download, switch, or delete models. Shows disk usage per model.
- **Memory** — clear all history and caches.

### 7. Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `R` | Start/stop recording (when the Upload view is active) |
| `1`–`4` | Switch views: Upload, Result, History, Settings |
| `Escape` | Close dialogs / cancel actions |

---

## Requirements (From Source)

If you'd rather run from source instead of the pre-built app:

- Python 3.11+
- A [DeepSeek API key](https://platform.deepseek.com/api_keys)
- Whisper model (downloaded automatically on first use; `tiny` is ~75 MB, `large-v3` is ~3 GB)

```bash
git clone https://github.com/MichelangeloAM/MeetingBuddy.git
cd MeetingBuddy
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Add your DEEPSEEK_API_KEY to .env
uvicorn app:app --host 127.0.0.1 --port 8765
```

Then open http://127.0.0.1:8765 in your browser.

To launch in a desktop window instead:
```bash
python launcher.py
```
Set `MEETINGGEN_BROWSER=1` to force the default browser.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | DeepSeek API key |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | API base URL |
| `WHISPER_MODEL` | `large-v3` | Whisper model variant (`tiny`, `small`, `medium`, `large-v3`) |
| `COMPUTE_TYPE` | `auto` | Whisper compute type (`int8`, `float16`, `auto`) |
| `WHISPER_BEAM_SIZE` | `1` | Beam search width (1 = fast, 5 = accurate) |
| `WHISPER_VAD_FILTER` | `true` | Voice activity detection to skip silence |
| `MEETINGGEN_BROWSER` | — | If set to `1`, launcher opens the browser instead of a native window |

## Project Structure

```
├── app.py              # FastAPI application and API routes
├── transcriber.py      # Whisper transcription (faster-whisper / mlx-whisper)
├── summarizer.py       # DeepSeek-powered meeting note generation
├── generator.py        # PDF / text / markdown export
├── prompts.py          # AI prompt templates
├── models.py           # Data models (MeetingNotes, Segment, JobStatus)
├── model_manager.py    # Whisper model download, cache, and deletion
├── settings.py         # App settings persistence
├── launcher.py         # pywebview desktop launcher
├── static/             # Frontend (JS, CSS)
├── templates/          # Jinja2 HTML template
└── tests/              # Smoke tests
```

## Building from Source

### macOS

```bash
source .venv/bin/activate
pip install pyinstaller
bash build_macos.sh
# Output: dist/MeetingGenerator.app and dist/MeetingGenerator.dmg
```

For a code-signed and notarized build, set these environment variables before running `build_macos.sh`:
- `CODESIGN_IDENTITY` — your Apple Developer ID certificate name
- `APPLE_ID`, `TEAM_ID`, `APP_PASSWORD` — for notarization
- `NOTARIZE=1` — enable notarization

### Windows

```bat
build_windows.bat
:: Output: dist\MeetingGenerator-Setup.exe (with NSIS) or dist\MeetingGenerator-Portable.zip
```

To code-sign the output, set `SIGN_CERT` to the path of your `.pfx` certificate file before running the script.

## Testing

```bash
python tests/smoke.py                # full end-to-end (needs 'tiny' model cached)
python tests/smoke.py --skip-e2e     # endpoint checks only, fast
```

## License

MIT — see [LICENSE.txt](LICENSE.txt).
