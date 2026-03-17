# Timeline segment pipeline: where start/end times live and how they update

## 1. Where are start and end times stored?

**In the parent (owner of state):**

- **Timeline demo:** [`app/timeline-demo.tsx`](../app/timeline-demo.tsx)  
  - `const [segments, setSegments] = useState<SegmentRecord[]>(DEMO_SEGMENTS)`  
  - So `segments` is React state: an array of `SegmentRecord` with `startTime`, `endTime`, `clipStart`, `clipEnd`, `clipFilename`.

- **Preview:** [`app/preview.tsx`](../app/preview.tsx)  
  - Same idea: `const [segments, setSegments] = useState<SegmentRecord[]>([])` (then filled from analyze result).

So the only place segment times are stored is that parent state. The strip does not own segment data; it receives `segments` as a prop and can only ask the parent to replace them via `onSegmentsChange(next)`.

---

## 2. Can the values be updated?

Yes. The parent can update them by calling `setSegments(next)` (or the wrapper it passes as `onSegmentsChange`). The strip never mutates the prop; it only ever calls `onSegmentsChange(next)` with a **new** array. The parent is responsible for doing `setSegments(next)` so that the next render has updated `segments` and passes new props to the strip.

---

## 3. Where do they get updated?

Only in the parent, when it runs its state setter:

- **Demo:**  
  `onSegmentsChange={(next) => { ...; setSegments((_prev) => next); }}`  
  So when the strip calls `onSegmentsChange(next)`, the demo runs `setSegments((_prev) => next)` and React replaces `segments` with `next`.

- **Preview:**  
  `onSegmentsChange={(next) => setSegments((_prev) => next)}`  
  Same idea.

So “where they get updated” is: **inside the parent’s `onSegmentsChange` handler, when it calls `setSegments(next)`.** The strip never touches the parent’s state directly; it only invokes the callback with the new array.

---

## 4. Does the gesture / resize logic update those times?

It does **not** update the parent state itself. It:

1. **Decides the gesture** (in `handleTouchStart`)  
   - Uses hit-test on `x` to choose: resize left, resize right, scrub, or tap.  
   - Does not read or write segment times; it only sets `gestureRef.current` (e.g. `resizeRight`, `segmentIndex`).

2. **Computes new segment times** (in `handleTouchMove`, for resize)  
   - Gets finger position `x`, converts to time: `newT = xToTime(x)`.  
   - Calls `applyResizeRight(segmentIndex, newT)` or `applyResizeLeft(segmentIndex, newT)`.  
   - Those functions:
     - Read **current** segments from `segmentsRef.current` (same as parent’s `segments`).
     - Compute a new cut time `T` (clamped so segments don’t exceed clip length).
     - Return a **new** array `next` with updated `startTime`/`endTime` (and `clipStart`/`clipEnd`) for the affected segments.  
   - So the **values** that would update the timeline are computed here; they are not yet stored anywhere.

3. **Asks the parent to apply them**  
   - If `next` is not null, the strip calls `onSegmentsChangeRef.current(next)`.  
   - That runs the parent’s callback, which does `setSegments((_prev) => next)`.  
   - Only at that point do the new start/end times become the new state and get passed back down as the `segments` prop.

So:

- The **gesture logic** (hit-test, drag) does **not** update start/end times by itself.
- The **resize logic** (`applyResizeRight` / `applyResizeLeft`) **computes** new start/end times and returns a new array.
- The **strip** passes that array to the parent via `onSegmentsChange(next)`.
- The **parent** is the only one that can **persist** those times, by calling `setSegments(next)`.

If “nothing is getting updated” in the UI or in “Log segments”, then either:

- The parent is not actually running `setSegments(next)` when the strip calls `onSegmentsChange(next)`, or  
- The parent is running it but the **contents** of `next` are the same as the current segments (e.g. because of clamping), so the displayed values don’t change.

---

**Conclusion from logs:** The **second** case is what happens. Logs show: `[TimelineDemo] onSegmentsChange called` every time (parent is running); `resizeMove` has `newT` varying but `nextCut: 5` every time (strip always passes seg[0].endTime = 5). So the parent runs setSegments(next) but the payload is identical (clamping). The issue is **clamping**, not the parent ignoring the callback.

## 5. Clamping and why you might not see a change (demo)

In the demo, each segment is 10s and each clip is 10s (e.g. segment 0: 0–10, clip 0–10). For **resize right** on segment 0:

- We move the cut between segment 0 and segment 1.
- Segment 0 cannot be longer than its clip: `endTime ≤ a.startTime + clipLenA` → `T ≤ 10`.
- So `maxT = min(b.endTime - 0.05, a.startTime + clipLenA) = min(19.95, 10) = 10` and we get `T = 10`.
- So when you drag **right** (trying to extend segment 0), `newT` might be 12, but we clamp to `T = 10`, and the returned `next` still has `seg[0].endTime === 10`. So the state “updates” (new array) but the numbers don’t change.

So:

- **Drag right** on segment 0 in the demo: clamp keeps cut at 10 → no visible change in segment times.
- **Drag left** (shrink segment 0): `newT` can be e.g. 8, so `T = 8` is valid → `next` has `seg[0].endTime = 8`, and that **does** get persisted when the parent runs `setSegments(next)`.

Summary: the pipeline **does** compute and pass new start/end times; the parent **does** persist them when it runs `setSegments(next)`. In the demo, you only see a change when the clamp actually allows a different `T` (e.g. shrinking segment 0). Making the demo segments shorter (e.g. 0–5, 5–15, …) would let extending also change the stored times.
