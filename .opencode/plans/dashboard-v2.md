# Dashboard v2 -- Full Implementation Plan

## Overview

Three tiers of improvements across 5 files:

| Tier | Focus | Backend | Frontend |
|---|---|---|---|
| 1 | Real-time progress & live transcript | SSE segment/phases, richer events | Live feed, phase pills, ETA, file info |
| 2 | Rich results | Expanded result, Markdown export | Tabs, copy, checkboxes, search, stats |
| 3 | History & polish | Persistence, GET/DELETE endpoints | History panel, dark mode, transitions |

---

## File 1: transcriber.py

Two changes:
1. Add segment_callback parameter to transcribe_sync
2. Return tuple (segments, audio_duration) instead of just segments

```python
def transcribe_sync(
    self,
    audio_path: str,
    progress_callback: Callable[[float, str], None] | None = None,
    segment_callback: Callable[[Segment], None] | None = None,
) -> tuple[list[Segment], float]:
```

Inside the loop, after segments.append(segment):
```python
if segment_callback:
    segment_callback(segment)
```

Return: segments, duration (instead of just segments)

---

## File 2: app.py

Full rewrite with these additions:

### New imports
import time
from datetime import datetime

### History persistence
- HISTORY_FILE = outputs/history.json, MAX_HISTORY = 50
- _load_history() -> list[dict] (loads from JSON file)
- _save_job_to_history(job) -> None (saves entry, deduplicates, limits to 50)
- _load_job_result(job_id) -> dict|None (disk cache for past results)

### New endpoints
- GET /api/jobs -- returns history list
- DELETE /api/job/{job_id} -- deletes job, cleans files
- GET /api/result/{job_id}/markdown -- markdown download

### Upload changes
Add to job dict: file_size, audio_duration, word_count, processing_time, created_at

### Expanded SSE status event
Adds audio_duration field

### Expanded GET /api/result/{job_id}
Adds: timed_segments, audio_duration, word_count, processing_time, metadata.
Falls back to disk cache if job no longer in memory.
Persists result to outputs/{job_id}_result.json.

### Rewritten _process_job
- Tracks start_time
- _thread_progress enriched with elapsed_seconds, audio_duration
- _thread_segment fires SSE segment events (text, start, end)
- _phase helper fires SSE phase events: loading_model, transcribing, summarizing
- audio_duration captured from transcriber return value
- word_count, processing_time stored on job dict
- _save_job_to_history called on completion AND on error
- Detailed code available in the full plan

---

## File 3: templates/index.html

Full rewrite with view-based layout:

Layout sections:
  header (title + dark mode toggle)
  main
    upload-view (idle: model selector + drop zone)
    processing-view (active: file info, phase pills, progress bar, live feed)
    result-view (done: stats bar, tabs [Overview|Transcript|Export], content)
    error-view (error: message + retry button)
    history-view (always: recent jobs list)

Each view toggled via CSS .hidden class. Result-view content rendered by JS.

---

## File 4: static/app.js

Complete rewrite using App state object (~400 lines).

```javascript
const App = {
    currentJobId: null,
    eventSource: null,
    segments: [],
    audioDuration: 0,
    lastSegmentEnd: 0,
    result: null,
    activeTab: "overview",
    searchQuery: "",

    // Lifecycle
    init()           // bind events, load history, apply theme, attach drag/drop
    reset()          // back to upload view, close SSE
    showView(name)   // toggle .hidden on view divs
    esc(text)        // HTML escape
    formatTime(sec)  // "1h 23m 45s"
    formatFileSize(b)// "12.3 MB"
    formatDate(iso)  // "Jul 15, 2026"

    // Upload
    uploadFile(file) // validate, POST /api/upload, connectSSE
    validFile(file)  // check extension

    // SSE handlers
    connectSSE(id)   // new EventSource, bind event listeners
    handleStatus(d)  // show processing view, set file info
    handlePhase(d)   // update phase pills (loading_model -> transcribing -> summarizing)
    handleProgress(d)// update bar %, calc ETA: speed = segEnd / elapsed, remaining = (audioDur - segEnd) / speed
    handleSegment(d) // append to live feed, auto-scroll, update counter
    handleDone()     // close SSE, fetch result, render tabs
    handleError(msg) // show error view

    // Results
    renderResult(data)    // build full result-view HTML
    buildOverview(data)   // summary (copy btn), key points, action items (checkboxes stored to localStorage), decisions, topics (tags), stats bar
    buildTranscript(data) // search box with match count, timed transcript [HH:MM:SS], copy button, highlighted matches
    buildExport(data)     // download buttons (PDF, Text, Markdown, JSON), plain text preview
    showTab(tab)          // switch active tab in UI

    // Actions
    copyToClipboard(text) // navigator.clipboard.writeText + animated "Copied!" toast
    loadHistoryJob(id)    // fetch /api/result/{id}, render result
    deleteJob(id)         // DELETE /api/job/{id}, remove from DOM, refresh
    loadHistory()         // GET /api/jobs, render history list
    searchTranscript()    // highlight matches in transcript tab

    // Theme
    toggleDarkMode()      // toggle html.dark class, save to localStorage
    applyTheme()          // read localStorage, apply on load
};
```

### SSE event schema:

| Event | Payload | UI update |
|---|---|---|
| status | {status, progress, message, audio_duration} | Show processing view, file info |
| phase | {phase: "loading_model"|"transcribing"|"summarizing"} | Update phase pills |
| progress | {progress, message, elapsed_seconds, audio_duration} | Bar %, ETA, status text |
| segment | {text, start, end} | Append to live feed, segment count++ |
| done | {message} | Close SSE, fetch result, render tabs |
| error | {message} | Show error view |

---

## File 5: static/style.css

Full rewrite (~550 lines) with CSS custom properties for dark mode.

### CSS Variables

:root:
  --bg: #f1f5f9
  --bg-card: #ffffff
  --bg-hover: #f8fafc
  --text: #0f172a
  --text-secondary: #64748b
  --text-muted: #94a3b8
  --border: #e2e8f0
  --accent: #3b82f6
  --accent-hover: #2563eb
  --accent-light: #eff6ff
  --danger: #dc2626
  --danger-hover: #b91c1c
  --success: #16a34a
  --warning: #f59e0b
  --shadow: 0 1px 3px rgba(0,0,0,0.06)
  --shadow-lg: 0 4px 12px rgba(0,0,0,0.08)
  --radius: 12px
  --radius-sm: 8px

html.dark:
  --bg: #0f172a
  --bg-card: #1e293b
  --bg-hover: #334155
  --text: #f1f5f9
  --text-secondary: #94a3b8
  --text-muted: #64748b
  --border: #334155
  --accent: #60a5fa
  --accent-hover: #3b82f6
  --accent-light: #1e3a5f
  --shadow: 0 1px 3px rgba(0,0,0,0.3)
  --shadow-lg: 0 4px 12px rgba(0,0,0,0.4)

### New component styles

- .theme-toggle -- round button, sun/moon icons
- .card -- background/border/radius/shadow container
- .phase-track + .phase-pill -- horizontal pill indicators with connecting lines, active/pending/done states
- .live-feed-card -- card variant with header
- .live-dot -- red pulsing dot (keyframes pulse)
- .live-feed -- scrollable transcript container, ~250px max-height
- .live-feed .segment -- each line: timestamp in monospace + text
- .stats-bar -- horizontal row of stat pills
- .stat-pill -- icon + label + value
- .tabs / .tab -- tab bar, active tab has bottom border + color
- .tab-content -- content area below tabs
- .checklist-item -- checkbox with label for action items
- .tag -- pill-style topic labels
- .history-section -- section heading + list
- .history-item -- row: name + meta on left, action buttons on right
- .history-actions -- flex row of small icon buttons
- .copy-btn -- small icon button next to section titles
- .copied-toast -- animated tooltip "Copied!" (fade out)
- .search-box -- input + match count badge
- .export-grid -- grid of download option cards (2x2)
- .btn-icon / .btn-danger -- button variants
- .view / .hidden -- view switching
- Animations: @keyframes pulse, fadeIn, slideIn

---

## Implementation Order

1. transcriber.py -- add segment_callback + return tuple (5 min)
2. app.py -- add new endpoints, expanded events, history, _process_job rewrite (20 min)
3. static/style.css -- full rewrite (25 min)
4. templates/index.html -- full rewrite (10 min)
5. static/app.js -- full rewrite (30 min)
6. Test end-to-end (10 min)

Total: ~100 min
