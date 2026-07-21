# Meeting Buddy

Record, transcribe, and summarize meetings locally with AI.

Meeting Buddy captures audio from your microphone or system audio, transcribes it using [Whisper](https://github.com/SYSTRAN/faster-whisper) (runs entirely on your machine), and generates structured meeting notes (summary, key points, action items, decisions, topics) using the [DeepSeek API](https://api.deepseek.com).

## Features

- **Local transcription** — powered by faster-whisper (CPU/GPU) or mlx-whisper (Apple Silicon)
- **AI summarization** — structured meeting notes via DeepSeek
- **Web UI** — clean, responsive interface built with vanilla JS
- **Desktop wrapper** — optional native window via pywebview (macOS/Windows)
- **Export formats** — PDF, Markdown, plain text, and JSON
- **Model management** — download, cache, and delete Whisper models from the Settings panel
- **History** — browse and revisit past meeting outputs
- **Real-time progress** — live transcription segments and summarization progress via SSE

## Quick Start

```bash
# Clone and set up
git clone https://github.com/MichelangeloAM/MeetingBuddy.git
cd MeetingBuddy
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# Configure
cp .env.example .env
# Add your DEEPSEEK_API_KEY to .env

# Run
uvicorn app:app --host 127.0.0.1 --port 8765
```

Then open http://127.0.0.1:8765.

### Desktop Window

```bash
python launcher.py
```

To force the default browser instead of a native window, set `MEETINGGEN_BROWSER=1`.

## Requirements

- Python 3.11+
- DeepSeek API key (set in `.env` or via the Settings panel)
- Whisper model (downloaded on first use or via Settings; `tiny` is ~75 MB, `large-v3` is ~3 GB)

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | DeepSeek API key |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | API base URL |
| `WHISPER_MODEL` | `large-v3` | Whisper model variant (`tiny`, `small`, `medium`, `large-v3`) |
| `COMPUTE_TYPE` | `auto` | Whisper compute type (`int8`, `float16`, `auto`) |
| `WHISPER_BEAM_SIZE` | `1` | Beam search width (1 = fast, 5 = accurate) |
| `WHISPER_VAD_FILTER` | `true` | Voice activity detection to skip silence |

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

## Building (macOS)

```bash
# Build the standalone .app
source .venv/bin/activate
pip install pyinstaller
bash build_macos.sh

# Create a .dmg
bash create_dmg.sh
```

## Testing

```bash
python tests/smoke.py                # full end-to-end (needs 'tiny' cached)
python tests/smoke.py --skip-e2e     # endpoint checks only, fast
```

## License

MIT — see [LICENSE.txt](LICENSE.txt).
