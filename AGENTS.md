# AGENTS.md

## Setup
- Python 3.14, virtualenv at `.venv` — activate with `source .venv/bin/activate`
- Install deps: `pip install -r requirements.txt`
- Copy `.env.example` to `.env` and fill in `DEEPSEEK_API_KEY`

## Environment
- `DEEPSEEK_API_KEY` — DeepSeek API key (default base URL: `https://api.deepseek.com`)
- `DEEPSEEK_BASE_URL` — DeepSeek API base URL (default `https://api.deepseek.com`)
- `WHISPER_MODEL` — whisper model variant (default `large-v3`)
- `COMPUTE_TYPE` — whisper compute type (default `auto`)
- `WHISPER_BEAM_SIZE` — beam search width, 1 for speed, 5 for accuracy (default `1`)
- `WHISPER_VAD_FILTER` — enable voice activity detection to skip silence (default `true`)

## Run
```bash
uvicorn app:app --host 127.0.0.1 --port 8765
```
Then open http://127.0.0.1:8765

Alternatively `python launcher.py` opens a native pywebview window (picks a free port automatically). Set `MEETINGGEN_BROWSER=1` to force the default browser instead.

## Smoke test
```bash
python tests/smoke.py                # full end-to-end (needs 'tiny' cached)
python tests/smoke.py --skip-e2e     # endpoint checks only, fast
```

## Git-ignored directories
- `models/` — downloaded whisper model files
- `outputs/` — generated meeting output files
- `.env` — secrets
- `runtime_port` — port picked by launcher.py (regenerated each launch)
- `build/`, `dist/` — PyInstaller build artefacts
