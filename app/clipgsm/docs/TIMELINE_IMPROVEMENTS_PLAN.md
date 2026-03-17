# Timeline editor – long-term improvements plan

Build and test **one item at a time**. Each item is independent enough to ship and debug before moving on.

---

## 0. Resizable timeline scale (two-finger zoom in scroll zone)

**Goal:** Make the timeline strip’s “zoom” (how many seconds one screen width represents) changeable via two-finger gestures in the area below the editing bar.

- **Current behavior:** One finger in the scroll zone = pan left/right through the overflow (unchanged).
- **New behavior in the same zone:**
  - **Two fingers spread (apart):** “Zoom in” the timeline → fewer seconds per screen width → e.g. 5 sec = width of screen → strip appears longer, more detail.
  - **Two fingers pinch (together):** “Zoom out” the timeline → more seconds per screen width → e.g. 20 sec = width of screen → strip appears shorter, more overview.

- **Default:** 10 sec per viewport width (current `SECONDS_PER_VIEWPORT`).
- **Bounds:** e.g. min 5 sec, max 20 sec (or 3–60) so the strip doesn’t become unusably long or short.

**Implementation:**

- **State:** Parent owns `secondsPerViewport` (number, default 10). TimelineStrip receives it as a prop (e.g. `secondsPerViewport?: number`) and uses it instead of the hardcoded constant to compute `stripWidth = (totalDuration / secondsPerViewport) * SCREEN_WIDTH`.
- **Scroll zone:** Keep one-finger scroll. Add two-finger gesture handling: track two touches; on move, compute pinch vs spread (distance change). Spread → decrease `secondsPerViewport` (zoom in, clamp to min). Pinch → increase `secondsPerViewport` (zoom out, clamp to max). Call parent callback e.g. `onSecondsPerViewportChange(newValue)` so parent updates state and passes new prop.
- **Optional:** Show current scale in UI (e.g. “5 s” / “10 s” / “20 s” per screen) for clarity.

**Scope:** TimelineStrip (prop, stripWidth from prop, two-finger handling in scroll zone); parent state + callback in timeline-demo and preview.

---

## 0b. Scrub zone above strip (playhead control + time stamp)

**Goal:** Separate "move playhead" from "resize clips" by adding a **small gesture zone above** the timeline strip. Scrubbing in that zone moves the time marker; the strip itself is used for clip selection and resize. A time stamp (e.g. `0:12`) appears above the playhead when the user scrubs there and fades out ~1 s after release.

- **Current behavior:** Playhead is moved by dragging near the line on the strip (scrub), which competes with resize/selection on the same strip.
- **New behavior:**
  - **Zone above strip:** A thin area (about **one-quarter** of the height of the scroll zone below) sits **above** the timeline strip. One-finger horizontal drag in this zone **only** moves the playhead (same as current scrub logic, but in a dedicated region).
  - **Time stamp:** When the user drags in that zone, a small label showing the current time (e.g. `0:12`) appears **above** the playhead line, inside that zone. It fades in when scrubbing starts and fades out roughly **1 second** after the user releases, so it's usually hidden and only visible during/just after scrubbing.

**Implementation:**

- **Layout:** Add a "scrub zone" `View` above the timeline `ScrollView` (same horizontal span as the viewport). Height = e.g. `SCROLL_ZONE_HEIGHT / 4` (smaller than the zone below).
- **Gestures:** In the scrub zone: `onTouchStart` → set scrubbing, show time stamp; `onTouchMove` → convert touch X to time (same as strip: `pageX - viewportLeft + timelineScrollX` → strip X → `xToTime(stripX)`), call `onPlayheadChange(t)`; `onTouchEnd` / `onTouchCancel` → clear scrubbing, start 1 s timer to hide time stamp.
- **Time stamp:** A label (e.g. `formatTime(playheadTime)`) positioned above the playhead (same X as the playhead line in viewport coords: `timeToX(playheadTime) - timelineScrollX`), centered on that X. Use opacity/Animated to fade in when scrubbing starts and fade out ~1 s after release.
- **Viewport height:** Increase the timeline viewport's min height by the scrub zone height so layout stays correct.

**Scope:** TimelineStrip only (new scrub zone View, touch handlers, time stamp state + animation). No parent API changes.

---

## 0c. Multi-frame thumbnails per clip (TikTok / iPhone style)

**Goal:** Show multiple thumbnail frames inside each clip rectangle instead of one large frame, so the strip reflects the clip's content over time (like TikTok or iPhone timeline).

- **Current behavior:** One thumbnail per segment (single frame, e.g. at clip start).
- **New behavior:** Each clip block displays a horizontal strip of small frames spaced roughly by timestamp (start to end of the clip). Frame count can be fixed (e.g. 6–12) or derived from segment length; frames are evenly spaced in the clip's time range.

**Implementation:**

- **TimelineStrip:** Add optional prop `thumbnailFrameUris?: (string | null)[][]`. For each segment `i`, if `thumbnailFrameUris[i]` exists and has length > 0, render the block as a row of `Image` components with equal width (each frame one slice). Otherwise fall back to existing single `thumbnailUris[i]` (one image for the whole block).
- **Preview (or any parent that has video):** When generating thumbnails, for each segment call `getThumbnailAsync` at several times (e.g. 8) evenly spaced between `clipStart` and `clipEnd`. Store result as `(string | null)[][]` and pass as `thumbnailFrameUris`. Keep `thumbnailUris` as fallback (e.g. first frame of each segment) so TimelineStrip can work with or without multi-frame data.
- **Constants:** Use a small max frame count per clip (e.g. 8 or 12) to limit work and layout; ensure minimum 1 frame width so very narrow blocks don't break.

**Scope:** TimelineStrip (new prop, conditional layout per block); preview (or timeline-demo) thumbnail generation loop to produce multiple frames per segment.

---

## 1. Alternative resize model: “Move cut” vs “Trim” (default = move cut)

**Goal:** Two resize behaviors, with **move cut** as the default.

- **Move cut (default):** Resizing only moves the cut between two clips; total video length and all other cut positions stay the same.
  - **Left edge:** Moving the start of a clip also moves the **end** of the **previous** clip. Only those two segments change; no other segments shift.
  - **Right edge:** Moving the end of a clip also moves the **start** of the **next** clip. Only those two segments change.
- **Trim (current behavior):** Resizing shortens/lengthens the clip and shifts all following segments (total duration changes).

**Implementation:** Add a `resizeMode: "moveCut" | "trim"` (default `"moveCut"`). TimelineStrip accepts this prop and uses different apply logic per mode. Add a toggle in the UI (e.g. “Trim mode” on/off or “Move cut” / “Trim”) so the user can switch. No change to data shape.

**Scope:** TimelineStrip (new applyResizeLeftMoveCut / applyResizeRightMoveCut or mode branch in existing apply), plus toggle in timeline-demo and preview.

---

## 2. JSON / data model: clip in/out (internal start/end)

**Goal:** Persisted cut/segment data explicitly includes **internal** clip range (which part of the source file is used).

- **Already in `SegmentRecord`:** `clipStart`, `clipEnd` (timeline-agnostic in-clip range).
- **Ensure:** Any JSON or API that saves/loads segments includes and restores `clipStart` and `clipEnd` so that “which part of the clip is selected” is never lost. Document this in the pipeline doc and verify export/import and backend use these fields.

**Scope:** Data flow, export/import, backend contract; no new UI.

---

## 3. Music persistence and library

**Goal:** User can name and save uploaded music; next time they can pick from previously uploaded tracks and organize a library.

- Store uploaded music somewhere (e.g. backend or local storage) with a user-defined name.
- “Select music” flow: list of saved tracks + option to upload new; selecting a saved track reuses it without re-upload.
- Allow naming and basic organization (e.g. list, optional folders or tags later).

**Scope:** Upload/name flow, storage (API or local), “my music” list in the music-selection UI.

---

## 4. Add cut at playhead (scissors button)

**Goal:** Button (e.g. scissors icon) that inserts a **cut at the current playhead** without changing total duration.

- At playhead time `T`, split the segment that contains `T` into two segments: one ending at `T`, one starting at `T`. Clip in/out for the new segment derived from the original (e.g. proportional split of `clipStart`–`clipEnd`).
- All segments after the split shift indices; total duration unchanged.

**Scope:** TimelineStrip or parent: “add cut at playhead” action; toolbar/button in preview (and optionally demo).

---

## 5. Replace clip (from library)

**Goal:** User selects a clip on the timeline, clicks “Replace”, and picks another video from their library to replace that segment.

- Replace keeps the same timeline span (start/end times of the segment) and optionally keeps or resets clip in/out for the new source.
- Replacement video must be at least as long as the segment (or we trim to available length and show a warning).

**Scope:** Replace button, “select from library” flow, segment update logic (filename + clipStart/clipEnd).

---

## 6. Replace with in-clip selection (modal + frame slider)

**Goal:** After choosing a replacement video, a modal opens with a **frame strip** (e.g. TikTok/Reels style) and a **fixed-length selection** (same duration as the segment being replaced). User slides the selection along the strip to choose which part of the new video to use; length of the selection does not change.

- Replacement video must be at least as long as the segment being replaced.
- Modal: video preview + thick frame strip; draggable selection rectangle; confirm applies `clipStart`/`clipEnd` (and possibly trims segment if we enforce duration).

**Scope:** New modal component, frame strip + selection UX, wiring from “Replace” flow.

---

## 7. Alter clip selection (same modal, “Selection” button)

**Goal:** For an **existing** segment, user can change which part of the **same** clip is used, without replacing the file.

- Select a clip on the timeline, click “Selection” (or “Edit in/out” / “Trim source”).
- Same modal as in (6): frame strip for the current clip, fixed-length selection (current segment duration); user slides to move the in/out range. Updates only `clipStart`/`clipEnd` for that segment; timeline start/end unchanged.

**Scope:** Reuse modal from (6); “Selection” button and “edit in/out for this segment” flow.

---

## Order and dependencies

| Order | Item | Depends on |
|-------|------|------------|
| 0 | Resizable timeline scale (two-finger zoom in scroll zone) | — |
| 0b | Scrub zone above strip (playhead + time stamp) | — |
| 1 | Move cut vs Trim + toggle | — |
| 2 | Clip in/out in JSON / data model | — |
| 3 | Music persistence & library | — |
| 4 | Scissors: add cut at playhead | — |
| 5 | Replace clip from library | — |
| 6 | Replace + selection modal (frame strip) | 5 |
| 7 | Alter selection (same modal) | 6 (reuse modal) |

Recommend building in this order: do **0** first (zoom in scroll zone), then continue with 1–7 so that (6) and (7) reuse the same modal and frame-strip component.
