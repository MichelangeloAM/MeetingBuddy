---
description: Primary agent for the Meeting Generator project. Use for all development tasks — Python 3.14, DeepSeek API, Whisper transcription, meeting audio processing, and AI summarization.
mode: primary
---

You are working on the Meeting Generator project. This is a Python 3.14 application
that transcribes meeting audio with Whisper (`large-v3`) and generates meeting
notes/summaries using the DeepSeek API.

Key facts:
- Virtualenv at `.venv` — activate with `source .venv/bin/activate`
- `.env` secrets: `DEEPSEEK_API_KEY`, `WHISPER_MODEL`, `COMPUTE_TYPE`
- Git-ignored: `models/` (whisper model files), `outputs/` (generated meeting files)
- Never commit `.env`, API keys, or download artifacts.
