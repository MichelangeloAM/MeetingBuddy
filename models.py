from dataclasses import dataclass, field
from enum import Enum


class JobStatus(str, Enum):
    QUEUED = "queued"
    TRANSCRIBING = "transcribing"
    SUMMARIZING = "summarizing"
    DONE = "done"
    ERROR = "error"
    CANCELLED = "cancelled"


@dataclass
class Segment:
    start: float
    end: float
    text: str
    speaker: str | None = None


@dataclass
class MeetingNotes:
    summary: str
    key_points: list[str]
    action_items: list[str]
    decisions: list[str]
    topics: list[str]
    transcript: str = ""
    segments: list[Segment] = field(default_factory=list)
