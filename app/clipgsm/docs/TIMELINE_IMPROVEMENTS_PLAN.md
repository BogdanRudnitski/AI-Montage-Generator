# Timeline editor – long-term improvements plan

Build and test **one item at a time**. Each item is independent enough to ship and debug before moving on.

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
| 1 | Move cut vs Trim + toggle | — |
| 2 | Clip in/out in JSON / data model | — |
| 3 | Music persistence & library | — |
| 4 | Scissors: add cut at playhead | — |
| 5 | Replace clip from library | — |
| 6 | Replace + selection modal (frame strip) | 5 |
| 7 | Alter selection (same modal) | 6 (reuse modal) |

Recommend building in this order so that (6) and (7) reuse the same modal and frame-strip component.
