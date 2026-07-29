import os
import threading
import time
from collections.abc import Callable

import httpx
from openai import OpenAI, APIError, APITimeoutError, APIConnectionError, AuthenticationError

from models import MeetingNotes
from prompts import SYSTEM_PROMPT, USER_PROMPT_TEMPLATE, get_output_language_instruction
from settings import get_api_key


ProgressCallback = Callable[[float, str], None]


def _get_client(api_key: str | None = None, timeout: float = 60.0) -> OpenAI:
    return OpenAI(
        api_key=api_key or get_api_key(),
        base_url=os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
        timeout=httpx.Timeout(timeout, connect=10.0),
    )


def _parse_response(content: str) -> MeetingNotes:
    sections: dict[str, str | list[str]] = {
        "summary": "",
        "key_points": [],
        "action_items": [],
        "decisions": [],
        "topics": [],
    }

    current_section: str | None = None

    for line in content.split("\n"):
        stripped = line.strip()
        if not stripped:
            continue

        upper = stripped.upper()

        if upper.startswith("##SUMMARY"):
            current_section = "summary"
            continue
        elif upper.startswith("##KEY_POINTS") or upper.startswith("##KEY POINTS"):
            current_section = "key_points"
            continue
        elif upper.startswith("##ACTION_ITEMS") or upper.startswith("##ACTION ITEMS"):
            current_section = "action_items"
            continue
        elif upper.startswith("##DECISIONS"):
            current_section = "decisions"
            continue
        elif upper.startswith("##TOPICS"):
            current_section = "topics"
            continue
        elif stripped.startswith("##"):
            current_section = None
            continue

        if current_section is None:
            continue

        if current_section == "summary":
            if sections["summary"]:
                sections["summary"] += " " + stripped
            else:
                sections["summary"] = str(stripped)
        else:
            if stripped.startswith("- "):
                item = stripped[2:].strip()
                low = item.lower()
                if low in ("none", "none mentioned", "n/a", "no"):
                    continue
                sections[current_section].append(item)

    key_points = sections["key_points"] or ["No key points extracted"]
    action_items = sections["action_items"] or ["No action items identified"]
    decisions = sections["decisions"] or ["No decisions recorded"]
    topics = sections["topics"] or ["No topics identified"]

    return MeetingNotes(
        summary=str(sections["summary"]) if sections["summary"] else "No summary available",
        key_points=list(key_points),
        action_items=list(action_items),
        decisions=list(decisions),
        topics=list(topics),
    )


def _estimate_expected_chars(transcript: str) -> int:
    # Reports typically compress transcripts ~3-6x. Cap for very long ones.
    words = max(50, len(transcript.split()))
    return min(6000, max(600, int(words * 0.9)))


class SummarizationCancelled(Exception):
    """Raised when a cancel_check callback returns True mid-stream."""


def _stream_with_progress(
    client: OpenAI,
    transcript: str,
    progress: ProgressCallback | None,
    cancel_check: Callable[[], bool] | None = None,
    output_language: str = "auto",
    detected_language: str = "",
) -> str:
    language_instruction = get_output_language_instruction(output_language, detected_language)
    system_prompt = SYSTEM_PROMPT.format(output_language_instruction=language_instruction)
    expected = _estimate_expected_chars(transcript)
    stream = client.chat.completions.create(
        model="deepseek-v4-flash",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": USER_PROMPT_TEMPLATE.format(transcript=transcript)},
        ],
        temperature=0.3,
        max_tokens=4096,
        stream=True,
    )
    parts: list[str] = []
    last_tick = 0.0
    for chunk in stream:
        if cancel_check and cancel_check():
            try:
                stream.close()
            except Exception:
                pass
            raise SummarizationCancelled()
        try:
            delta = chunk.choices[0].delta.content or ""
        except (AttributeError, IndexError):
            delta = ""
        if delta:
            parts.append(delta)
        now = time.time()
        if progress and now - last_tick > 0.4:
            written = sum(len(p) for p in parts)
            pct = min(95.0, (written / expected) * 95.0)
            progress(pct, f"Generated {written} of ~{expected} chars…")
            last_tick = now
    if progress:
        progress(97.0, "Finalizing…")
    return "".join(parts)


def _fake_progress_worker(stop_event: threading.Event, progress: ProgressCallback, expected_seconds: float) -> None:
    start = time.time()
    while not stop_event.is_set():
        elapsed = time.time() - start
        pct = min(85.0, (elapsed / expected_seconds) * 85.0)
        progress(pct, "Analyzing meeting (estimated)…")
        if stop_event.wait(0.7):
            return


def generate_meeting_notes(
    transcript: str,
    progress_callback: ProgressCallback | None = None,
    cancel_check: Callable[[], bool] | None = None,
    output_language: str = "auto",
    detected_language: str = "",
) -> MeetingNotes:
    if progress_callback:
        progress_callback(2.0, "Contacting DeepSeek…")

    client = _get_client()

    try:
        content = _stream_with_progress(
            client, transcript, progress_callback, cancel_check,
            output_language=output_language,
            detected_language=detected_language,
        )
    except SummarizationCancelled:
        raise
    except (APIError, APITimeoutError, APIConnectionError, AuthenticationError):
        raise
    except Exception:
        # Fallback to non-streaming with timer-based fake progress.
        stop_event = threading.Event()
        expected_seconds = max(15.0, len(transcript.split()) / 500.0)
        thread = None
        if progress_callback:
            thread = threading.Thread(
                target=_fake_progress_worker,
                args=(stop_event, progress_callback, expected_seconds),
                daemon=True,
            )
            thread.start()
        try:
            language_instruction = get_output_language_instruction(output_language, detected_language)
            system_prompt = SYSTEM_PROMPT.format(output_language_instruction=language_instruction)
            response = client.chat.completions.create(
                model="deepseek-v4-flash",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": USER_PROMPT_TEMPLATE.format(transcript=transcript)},
                ],
                temperature=0.3,
                max_tokens=4096,
            )
            content = response.choices[0].message.content or ""
        finally:
            stop_event.set()
            if thread is not None:
                thread.join(timeout=1.5)

    notes = _parse_response(content)
    if progress_callback:
        progress_callback(100.0, "Summary ready")
    return notes


def test_connection(api_key: str | None = None) -> tuple[bool, str, float | None]:
    key = (api_key or "").strip() or get_api_key()
    if not key:
        return False, "API key is empty", None

    client = _get_client(api_key=key, timeout=8.0)
    start = time.time()
    try:
        client.models.list()
        return True, "Connection successful", (time.time() - start) * 1000.0
    except AuthenticationError:
        return False, "Invalid API key", None
    except (APITimeoutError, APIConnectionError) as e:
        return False, f"Connection error: {e}", None
    except APIError as e:
        # Some providers don't implement /models; fall back to a 1-token completion.
        try:
            start = time.time()
            client.chat.completions.create(
                model="deepseek-v4-flash",
                messages=[{"role": "user", "content": "ping"}],
                max_tokens=1,
                temperature=0,
            )
            return True, "Connection successful", (time.time() - start) * 1000.0
        except AuthenticationError:
            return False, "Invalid API key", None
        except Exception as e2:
            return False, f"API error: {e2}", None
    except Exception as e:
        return False, f"Unexpected error: {e}", None
