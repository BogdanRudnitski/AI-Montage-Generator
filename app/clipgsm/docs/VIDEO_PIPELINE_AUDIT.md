# Video Import/Storage Pipeline – Audit & Refactor

## 1. Files, functions, and endpoints involved

### Backend (`app/backend/main.py`)
- **`media_stable_id(original_filename, file_size_bytes)`** – Single shared sanitization: same input → same stable ID (no extension). Deterministic, collision-safe.
- **`_original_extension(raw_filename)`** – Returns original extension for stored file (e.g. .mov, .mp4). Used so stored filename = stable_id + original_extension.
- **`POST /clear-uploads`** – Clears `uploads/media`. Used by homepage for new session.
- **`POST /upload-single`** – Upload one or more files; **saved exactly as received** (no transcoding, no ffmpeg). Form `deduplicate`: `"false"` = always save (session); `"true"` = reuse if same file already exists (preview replace). Stored as `uploads/media/{stable_id}{original_extension}` (e.g. abc123.mov, def456.mp4).
- **`POST /media-stable-id`** – Body: `{ "filename", "file_size" }`. Returns `{ "stable_id", "filename" }` where filename = stable_id + original extension. Used by preview to check existence before uploading.
- **`GET /media/exists?stable_id=...`** – Returns `{ "exists", "filename" }` (filename = actual stored name, any extension). Preview uses this to skip upload when clip already on backend.
- **`POST /upload`** – Legacy batch upload: stable ID + original extension, save as received; clears media first.
- **`POST /analyze`** – Runs AI; segments use clipFilename = actual stored filenames in `uploads/media` (any supported video extension).
- **`POST /export`** – Writes `segments.json` from body; `clip_maker` resolves `clipFilename` to files in `uploads/media`.

### AI (`app/ai/`)
- **`clip_maker.ClipManager`** – Loads clips from `backend/uploads/media`; accepts all supported video extensions (.mp4, .mov, .avi, .mkv, .webm, .m4v). clipFilename always matches stored backend filename.
- **`clip_maker.compute_segments_only()`** – Builds segments with `clipFilename` = clip’s filename (stable_id + ext).
- **`compute_segments.py`** – Writes `analyze_result.json` and `segments.json`; segment `clipFilename` matches files in `uploads/media`.

### Frontend
- **`app/clipgsm/app/index.tsx`** – Homepage. `uploadSingleFile()` sends `deduplicate: "false"`. New session: calls `clear-uploads` then uploads all selected videos. Uses returned `serverFilename` (stable_id + ext) for analyze/preview.
- **`app/clipgsm/app/preview.tsx`** – Replace flow: if `fileSize` available → `POST /media-stable-id` → `GET /media/exists`. If exists → reuse returned `filename` (no upload). Else → `POST /upload-single` with `deduplicate: "true"`. Segment and mediaList use returned filename (actual stored name including extension).
- **`app/clipgsm/context/AnalyzeContext.tsx`** – `mediaList` and segments use `filename` / `clipFilename` = actual backend stored filename.

---

## 2. Previous bug-prone flow (before stable ID)

- **A/B/C naming**: Order-dependent; 26-clip limit; replace flow appended D, E, …; fragile segment ↔ file matching.
- **Replace vs export**: Replacement clips could get out of sync with backend; export failed (“file not found”).
- **No reuse**: Same video picked again was uploaded twice.

---

## 3. Current flow (stable ID; no conversion)

1. **Stored as received**  
   No transcoding or ffmpeg. Each upload is saved in its **original format/extension** as `uploads/media/{stable_id}{original_extension}` (e.g. abc123.mov, def456.mp4). Fast uploads; clipFilename always matches the actual stored file.

2. **Stable, deterministic naming**  
   `media_stable_id(original_filename, file_size_bytes)` is the single shared function. Same file (same name + size) → same stable_id. Stored filename = stable_id + original extension.

3. **Homepage / initial upload**  
   - User selects videos → **always re-upload** for that session.  
   - Frontend calls `clear-uploads` when starting a new session, then `POST /upload-single` with `deduplicate: "false"`.  
   - Backend saves file as received, returns stored filename (stable_id + ext). Analyze/preview/export use this clipFilename.

4. **Preview “replace clip” flow**  
   - If `fileSize` present → `POST /media-stable-id` → `GET /media/exists?stable_id=...`. If exists → use returned `filename` (no upload).  
   - Else → `POST /upload-single` with `deduplicate: "true"`. Backend saves as received; if file with same stable_id already exists, reuses it.  
   - Segment and mediaList use the actual stored filename (any extension).

5. **Analyze / preview / export**  
   All use the same stable clipFilename (= actual stored backend filename, including extension). No format assumed; backend listing and clip_maker accept all supported video extensions.

---

## 4. Where each requirement is handled in code

- **No conversion / save as received**: `upload-single` and batch `upload` use `shutil.copy2` from temp to final path; no `normalize_video_to_mp4` or ffmpeg.
- **Stable ID + original extension**: `media_stable_id()` + `_original_extension()` in `main.py`; stored name = stable_id + ext.
- **Session upload (always re-upload)**: Homepage sends `deduplicate: "false"` and calls `clear-uploads` for new session in `index.tsx`.
- **Preview replacement reuse**: `preview.tsx` calls `/media-stable-id` and `/media/exists` when `fileSize` is available; uploads with `deduplicate: "true"` otherwise.
- **clipFilename = actual stored filename**: Backend returns and frontend uses the real stored name (e.g. abc123.mov); clip_maker and listing accept all MEDIA_EXTENSIONS.
