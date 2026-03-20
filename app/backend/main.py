from fastapi import FastAPI, UploadFile, File, Form, Body, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
import os
import shutil
import json
import re
import hashlib
import tempfile
from typing import List, Optional
from pathlib import Path
from urllib.parse import unquote
import subprocess
from datetime import datetime
from array import array

app = FastAPI()

# Allow frontend access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Ensure upload directories exist (media = normalized MP4 clips only; see MEDIA_DIR below)
os.makedirs("uploads/media", exist_ok=True)
os.makedirs("uploads/songs", exist_ok=True)
os.makedirs("uploads/final_videos", exist_ok=True)

# Static folders
app.mount("/files/media", StaticFiles(directory="uploads/media"), name="media")
app.mount("/files/songs", StaticFiles(directory="uploads/songs"), name="songs")
app.mount("/files/final_videos", StaticFiles(directory="uploads/final_videos"), name="final_videos")

# -------------------------
# MEDIA: STABLE DETERMINISTIC NAMING, ORIGINAL FORMAT STORED
# Videos are stored as uploads/media/{stable_id}{original_extension} (e.g. abc123.mov, def456.mp4).
# No transcoding or conversion: save exactly as received for fast uploads.
# Stable ID = deterministic from (original_filename + file_size). clipFilename = actual stored filename.
# -------------------------
MEDIA_EXTENSIONS = ('.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v')
MEDIA_DIR = "uploads/media"


def media_stable_id(original_filename: str, file_size_bytes: int) -> str:
    """
    Single shared sanitization: same input always produces the same stable ID (no extension).
    Deterministic, collision-safe. Stored filename = stable_id + original_extension.
    """
    base = (original_filename or "unnamed").strip()
    name, ext = os.path.splitext(base)
    slug = re.sub(r"[^\w\-.]", "_", name.lower())[:80].strip("_") or "clip"
    hash_input = f"{original_filename}:{file_size_bytes}"
    hash_part = hashlib.sha256(hash_input.encode()).hexdigest()[:12]
    return f"{slug}_{hash_part}"


def _original_extension(raw_filename: str) -> str:
    """Preserve original extension for stored file; default .mp4 if missing/invalid."""
    ext = os.path.splitext((raw_filename or "").strip())[1].lower()
    if ext and ext in MEDIA_EXTENSIONS:
        return ext
    return ".mp4"

# -------------------------
# FILENAME SANITIZATION
# -------------------------
def sanitize_filename(filename: str) -> str:
    """Remove or replace problematic characters in filenames"""
    # Keep the extension
    name, ext = os.path.splitext(filename)
    
    # Replace spaces with underscores
    name = name.replace(' ', '_')
    
    # Remove or replace special characters, keep only alphanumeric, underscore, hyphen, dot
    name = re.sub(r'[^\w\-.]', '', name)
    
    # Remove multiple consecutive underscores
    name = re.sub(r'_+', '_', name)
    
    # Remove leading/trailing underscores
    name = name.strip('_')
    
    return name + ext

# -------------------------
# VIDEO COMPRESSION & CONVERSION
# -------------------------
def get_video_size_mb(video_path: str) -> float:
    """Get video file size in MB"""
    try:
        size_bytes = os.path.getsize(video_path)
        return size_bytes / (1024 * 1024)
    except:
        return 0

def get_video_info(video_path: str) -> dict:
    """Get video codec, resolution, and duration"""
    try:
        probe = subprocess.run([
            'ffprobe',
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name,width,height',
            '-show_entries', 'format=duration',
            '-of', 'json',
            video_path
        ], capture_output=True, text=True, check=True)
        
        info = json.loads(probe.stdout)
        codec = info['streams'][0]['codec_name'] if 'streams' in info and info['streams'] else 'unknown'
        width = info['streams'][0].get('width', 0) if 'streams' in info and info['streams'] else 0
        height = info['streams'][0].get('height', 0) if 'streams' in info and info['streams'] else 0
        duration = float(info['format'].get('duration', 0)) if 'format' in info else 0
        
        return {
            'codec': codec,
            'width': width,
            'height': height,
            'duration': duration
        }
    except:
        return {'codec': 'unknown', 'width': 0, 'height': 0, 'duration': 0}

def compress_video(video_path: str) -> str:
    """Compress video based on size with aggressive settings for large files"""
    try:
        size_mb = get_video_size_mb(video_path)
        video_info = get_video_info(video_path)
        
        print(f"Video: {video_path}")
        print(f"  Size: {size_mb:.1f} MB")
        print(f"  Codec: {video_info['codec']}")
        print(f"  Resolution: {video_info['width']}x{video_info['height']}")
        print(f"  Duration: {video_info['duration']:.1f}s")
        
        # Determine if compression is needed
        needs_compression = False
        crf = 23  # Default quality (lower = better, 18-28 is reasonable range)
        max_width = 1920  # Default max resolution
        
        if size_mb > 100:
            # Very large files: aggressive compression
            needs_compression = True
            crf = 28
            max_width = 1280
            print(f"  → Large file detected, using aggressive compression (CRF={crf}, max_width={max_width})")
        elif size_mb > 50:
            # Large files: moderate compression
            needs_compression = True
            crf = 26
            max_width = 1920
            print(f"  → Medium file detected, using moderate compression (CRF={crf})")
        elif size_mb > 20:
            # Medium files: light compression
            needs_compression = True
            crf = 24
            print(f"  → Using light compression (CRF={crf})")
        elif video_info['codec'] != 'h264':
            # Small files but wrong codec
            needs_compression = True
            crf = 23
            print(f"  → Converting codec to H.264")
        else:
            print(f"  → No compression needed (already H.264, size OK)")
            return video_path
        
        # Build ffmpeg command
        output_path = video_path.rsplit('.', 1)[0] + '_compressed.mp4'
        
        # Scale filter if resolution is too high
        scale_filter = []
        if video_info['width'] > max_width:
            scale_filter = ['-vf', f'scale={max_width}:-2']
            print(f"  → Downscaling to max width {max_width}px")
        
        cmd = [
            'ffmpeg',
            '-i', video_path,
            '-c:v', 'libx264',
            '-preset', 'medium',
            '-crf', str(crf),
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            '-y'
        ]
        
        if scale_filter:
            cmd.extend(scale_filter)
        
        cmd.append(output_path)
        
        # Run compression
        subprocess.run(cmd, check=True, capture_output=True, stderr=subprocess.PIPE)
        
        # Check compression results
        if os.path.exists(output_path):
            new_size_mb = get_video_size_mb(output_path)
            compression_ratio = (1 - new_size_mb / size_mb) * 100 if size_mb > 0 else 0
            
            print(f"  ✓ Compressed: {size_mb:.1f} MB → {new_size_mb:.1f} MB ({compression_ratio:.1f}% reduction)")
            
            # Replace original with compressed version
            os.remove(video_path)
            final_path = video_path.rsplit('.', 1)[0] + '.mp4'
            os.rename(output_path, final_path)
            
            return final_path
        else:
            print(f"  ✗ Compression failed, keeping original")
            return video_path
        
    except FileNotFoundError:
        print("Warning: ffmpeg/ffprobe not found. Install to enable video compression.")
        return video_path
    except Exception as e:
        print(f"Warning: Could not compress video {video_path}: {e}")
        return video_path

# -------------------------
# CLEAR UPLOADS FOLDER
# -------------------------
@app.post("/clear-uploads")
async def clear_uploads():
    """Clear all media files (not songs). Homepage uses this for new session before re-upload."""
    try:
        shutil.rmtree(MEDIA_DIR, ignore_errors=True)
        os.makedirs(MEDIA_DIR, exist_ok=True)
        print("✓ Cleared uploads/media folder")
        return {"success": True, "message": "Media folder cleared"}
    except Exception as e:
        print(f"Error clearing uploads: {e}")
        return {"success": False, "error": str(e)}

# -------------------------
# UPLOAD SINGLE FILE (session upload or preview replacement)
# Save as received: no transcoding, no ffmpeg. Stored as {stable_id}{original_extension}.
# Session (homepage): deduplicate=False → always save. Preview replace: deduplicate=True → reuse if exists.
# -------------------------
@app.post("/upload-single")
async def upload_single_file(
    files: List[UploadFile] = File(...),
    deduplicate: str = Form("false"),
):
    dedupe = deduplicate.strip().lower() in ("true", "1", "yes")
    saved_files = []
    os.makedirs(MEDIA_DIR, exist_ok=True)
    
    for f in files:
        raw = (f.filename or "unnamed").strip()
        ext = _original_extension(raw)
        with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
            shutil.copyfileobj(f.file, tmp)
            tmp_path = tmp.name
        try:
            file_size = os.path.getsize(tmp_path)
            stable_id = media_stable_id(raw, file_size)
            final_name = stable_id + ext
            final_path = os.path.join(MEDIA_DIR, final_name)

            if dedupe and os.path.isfile(final_path):
                print(f"[TRACE] upload-single dedupe: reusing existing {final_name}")
                saved_files.append(final_name)
                continue

            shutil.copy2(tmp_path, final_path)
            print(f"Saved (as received): {final_path}")
            saved_files.append(final_name)
        finally:
            if os.path.isfile(tmp_path):
                os.unlink(tmp_path)

    return {"success": True, "files_saved": saved_files}


# -------------------------
# STABLE ID + EXISTS (for preview replacement: verify before uploading)
# Same media_stable_id() used here so frontend can ask "does this exact video exist?" by identity.
# -------------------------
@app.post("/media-stable-id")
async def get_media_stable_id(body: dict = Body(...)):
    """Return stable_id and stored filename (stable_id + original extension) for given filename + file_size."""
    filename = (body.get("filename") or body.get("original_filename") or "unnamed").strip()
    file_size = int(body.get("file_size") or body.get("file_size_bytes") or 0)
    stable_id = media_stable_id(filename, file_size)
    ext = _original_extension(filename)
    return {"stable_id": stable_id, "filename": stable_id + ext}


@app.get("/media/exists")
async def media_exists(stable_id: str = Query(..., alias="stable_id")):
    """Check if a clip with this stable ID already exists (any stored extension). Returns actual filename if exists."""
    media_path = Path(MEDIA_DIR)
    if not media_path.is_dir():
        return {"exists": False, "filename": None}
    for f in media_path.iterdir():
        if f.is_file() and f.suffix.lower() in MEDIA_EXTENSIONS and f.stem == stable_id:
            return {"exists": True, "filename": f.name}
    return {"exists": False, "filename": None}


# -------------------------
# UPLOAD SONG (NO COMPRESSION)
# -------------------------
@app.post("/upload-song")
async def upload_song(
    song: UploadFile = File(...),
    max_duration: str = Form("30"),
    density: str = Form("medium"),
    aggressiveness: str = Form("0.7"),
    focus_bass: str = Form("true"),
    focus_vocals: str = Form("true"),
    focus_repetitions: str = Form("true"),
    sync_to_grid: str = Form("false"),
    song_start_sec: str = Form("0"),
):
    """Upload song without compression"""
    # Clear previous song
    shutil.rmtree("uploads/songs", ignore_errors=True)
    os.makedirs("uploads/songs", exist_ok=True)
    
    song_path = f"uploads/songs/{song.filename}"
    with open(song_path, "wb") as buffer:
        shutil.copyfileobj(song.file, buffer)
    
    print(f"Saved song: {song_path} (no compression)")
    
    # Parse boolean strings
    def parse_bool(value: str) -> bool:
        return value.lower() in ('true', '1', 'yes')
    
    # Save options.json (AI reads minClipDuration/maxClipDuration for segment generation)
    existing_options = _read_json_file(Path("uploads/options.json"), {})
    try:
        _song_start = float(song_start_sec or 0)
    except ValueError:
        _song_start = 0.0
    options_data = {
        "max_duration": int(max_duration),
        "density": density,
        "aggressiveness": float(aggressiveness),
        "focus_bass": parse_bool(focus_bass),
        "focus_vocals": parse_bool(focus_vocals),
        "focus_repetitions": parse_bool(focus_repetitions),
        "sync_to_grid": parse_bool(sync_to_grid),
        "song_filename": song.filename,
        "song_start_sec": max(0.0, _song_start),
        "minClipDuration": 0.1,
        "maxClipDuration": None,
        "tap_mode": existing_options.get("tap_mode"),
    }
    options_path = "uploads/options.json"
    with open(options_path, "w") as f:
        json.dump(options_data, f, indent=2)
    
    print(f"Saved options: {options_data}")
    
    return {
        "success": True,
        "song_saved": song.filename,
        "options": options_data
    }

# -------------------------
# BATCH UPLOAD (legacy): stable ID + original extension, save as received. Clear media first.
# -------------------------
@app.post("/upload")
async def upload_media(
    files: List[UploadFile] = File(...),
    song: Optional[UploadFile] = File(None),
    max_duration: str = Form("30"),
    density: str = Form("medium"),
    aggressiveness: str = Form("0.7"),
    focus_bass: str = Form("true"),
    focus_vocals: str = Form("true"),
    focus_repetitions: str = Form("true"),
    sync_to_grid: str = Form("false"),
    song_start_sec: str = Form("0"),
):
    shutil.rmtree(MEDIA_DIR, ignore_errors=True)
    shutil.rmtree("uploads/songs", ignore_errors=True)
    os.makedirs(MEDIA_DIR, exist_ok=True)
    os.makedirs("uploads/songs", exist_ok=True)
    saved_files = []

    for f in files:
        raw = (f.filename or "unnamed").strip()
        ext = _original_extension(raw)
        with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
            shutil.copyfileobj(f.file, tmp)
            tmp_path = tmp.name
        try:
            file_size = os.path.getsize(tmp_path)
            stable_id = media_stable_id(raw, file_size)
            final_name = stable_id + ext
            final_path = os.path.join(MEDIA_DIR, final_name)
            shutil.copy2(tmp_path, final_path)
            print(f"Saved (as received): {final_path}")
            saved_files.append(final_name)
        finally:
            if os.path.isfile(tmp_path):
                os.unlink(tmp_path)

    song_saved = None
    if song:
        # Sanitize song filename (NO COMPRESSION FOR SONGS)
        sanitized_song_name = sanitize_filename(song.filename)
        song_path = f"uploads/songs/{sanitized_song_name}"
        
        print(f"Original song filename: {song.filename}")
        print(f"Sanitized song filename: {sanitized_song_name}")
        
        with open(song_path, "wb") as buffer:
            shutil.copyfileobj(song.file, buffer)
        song_saved = sanitized_song_name
        print(f"Saved song: {song_path} (no compression)")

    # Parse boolean strings
    def parse_bool(value: str) -> bool:
        return value.lower() in ('true', '1', 'yes')

    # Save options.json with all parameters
    existing_options = _read_json_file(Path("uploads/options.json"), {})
    try:
        _song_start_u = float(song_start_sec or 0)
    except ValueError:
        _song_start_u = 0.0
    options_data = {
        "max_duration": int(max_duration),
        "density": density,
        "aggressiveness": float(aggressiveness),
        "focus_bass": parse_bool(focus_bass),
        "focus_vocals": parse_bool(focus_vocals),
        "focus_repetitions": parse_bool(focus_repetitions),
        "sync_to_grid": parse_bool(sync_to_grid),
        "song_start_sec": max(0.0, _song_start_u),
    }
    if song_saved:
        options_data["song_filename"] = song_saved
        
    options_data["minClipDuration"] = 0.1
    options_data["maxClipDuration"] = None
    options_data["tap_mode"] = existing_options.get("tap_mode")
    options_path = "uploads/options.json"
    with open(options_path, "w") as f:
        json.dump(options_data, f, indent=2)
    print(f"Saved options: {options_data}")

    print(f"Total files saved: {saved_files}")
    return {
        "files_saved": saved_files, 
        "song_saved": song_saved,
        "options": options_data
    }

# -------------------------
# AI PATHS (run from backend dir, so ../ai is app/ai)
# -------------------------
AI_DIR = Path(__file__).resolve().parent / ".." / "ai"
MAIN_AI_SCRIPT = AI_DIR / "main.py"
ANALYZE_SCRIPT = AI_DIR / "analyze.py"
CALIBRATE_SCRIPT = AI_DIR / "calibrate.py"
COMPUTE_SEGMENTS_SCRIPT = AI_DIR / "compute_segments.py"
CLIP_MAKER_SCRIPT = AI_DIR / "clip_maker.py"
AI_VENV_PYTHON = AI_DIR / "venv" / "bin" / "python3"
ANALYZE_RESULT_FILE = Path("uploads/analyze_result.json")
ANALYZE_RESULT_FOR_PREVIEW_FILE = Path("uploads/analyze_result_for_preview.json")
TAPS_FILE = Path("uploads/taps.json")
OPTIONS_FILE = Path("uploads/options.json")


def _read_json_file(path: Path, default_value):
    if not path.exists():
        return default_value
    with open(path, "r") as f:
        return json.load(f)


def _write_json_atomic(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", delete=False, dir=str(path.parent), suffix=".tmp") as tmp:
        json.dump(data, tmp, indent=2)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp_name = tmp.name
    os.replace(tmp_name, path)


def _materialize_song_taps_file(song_filename: str, taps_entry: dict) -> None:
    """Write per-song taps files used by analyze.py/calibrate.py from shared taps.json entry."""
    taps_dir = Path("uploads/taps")
    taps_dir.mkdir(parents=True, exist_ok=True)
    stem = Path(song_filename).stem
    payload = {
        "song": song_filename,
        "recorded_at": taps_entry.get("recorded_at"),
        "cut_count": int(taps_entry.get("cut_count", len(taps_entry.get("manual_cuts") or []))),
        "manual_cuts": taps_entry.get("manual_cuts") or [],
    }
    _write_json_atomic(taps_dir / f"{song_filename}.json", payload)
    _write_json_atomic(taps_dir / f"{stem}.json", payload)


@app.post("/api/taps/save")
async def save_taps(body: dict = Body(...)):
    try:
        song_filename = (body.get("song_filename") or "").strip()
        manual_cuts = body.get("manual_cuts") or []
        if not song_filename:
            return {"success": False, "error": "song_filename is required"}
        taps_data = _read_json_file(TAPS_FILE, {})
        taps_data[song_filename] = {
            "song": song_filename,
            "recorded_at": body.get("recorded_at") or datetime.utcnow().isoformat() + "Z",
            "cut_count": len(manual_cuts),
            "manual_cuts": manual_cuts,
        }
        _write_json_atomic(TAPS_FILE, taps_data)
        # Keep per-song tap file in sync so analyze verbatim never reads stale data.
        _materialize_song_taps_file(song_filename, taps_data[song_filename])
        return {"success": True, "cut_count": len(manual_cuts)}
    except Exception as e:
        return {"success": False, "error": str(e)}


@app.get("/api/taps/{song_filename:path}")
async def get_taps(song_filename: str):
    try:
        decoded = unquote(song_filename).strip()
        taps_data = _read_json_file(TAPS_FILE, {})
        entry = taps_data.get(decoded)
        if entry is None:
            return {"manual_cuts": []}
        return entry
    except Exception:
        return {"manual_cuts": []}


@app.get("/api/song-waveform")
async def get_song_waveform(song_filename: Optional[str] = Query(None), bars: int = Query(72)):
    """Return normalized waveform bars for the uploaded song using ffmpeg PCM decode."""
    try:
        bars = max(16, min(256, int(bars or 72)))
        options = _read_json_file(OPTIONS_FILE, {})
        target_name = (song_filename or options.get("song_filename") or "").strip()
        songs_dir = Path("uploads/songs")
        if not songs_dir.exists():
            return {"bars": [0.2] * bars}
        song_path: Optional[Path] = None
        if target_name:
            exact = songs_dir / target_name
            if exact.exists():
                song_path = exact
            else:
                target_norm = unquote(target_name).strip().lower()
                for f in songs_dir.iterdir():
                    if f.is_file() and unquote(f.name).strip().lower() == target_norm:
                        song_path = f
                        break
        if song_path is None:
            song_path = next((f for f in songs_dir.iterdir() if f.is_file()), None)
        if song_path is None:
            return {"bars": [0.2] * bars}

        pcm = subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                str(song_path),
                "-ac",
                "1",
                "-ar",
                "8000",
                "-f",
                "s16le",
                "pipe:1",
            ],
            capture_output=True,
            check=False,
        )
        raw = pcm.stdout or b""
        if len(raw) < 4:
            return {"bars": [0.2] * bars}
        samples = array("h")
        samples.frombytes(raw)
        total = len(samples)
        if total == 0:
            return {"bars": [0.2] * bars}

        chunk = max(1, total // bars)
        out = []
        max_abs = 1.0
        for i in range(bars):
            start = i * chunk
            end = total if i == bars - 1 else min(total, (i + 1) * chunk)
            if start >= total:
                out.append(0.0)
                continue
            seg = samples[start:end]
            if not seg:
                out.append(0.0)
                continue
            peak = max(abs(v) for v in seg)
            out.append(float(peak))
            if peak > max_abs:
                max_abs = float(peak)
        normalized = [round(max(0.06, min(1.0, v / max_abs)), 4) for v in out]
        return {"bars": normalized, "song_filename": song_path.name}
    except Exception:
        return {"bars": [0.2] * max(16, min(256, int(bars or 72)))}


@app.post("/api/options")
async def update_options(body: dict = Body(...)):
    try:
        existing = _read_json_file(OPTIONS_FILE, {})
        existing.update(body or {})
        _write_json_atomic(OPTIONS_FILE, existing)
        return {"success": True, "options": existing}
    except Exception as e:
        return {"success": False, "error": str(e)}


@app.post("/api/calibrate")
async def run_calibrate(body: dict = Body(...)):
    try:
        if not AI_VENV_PYTHON.exists():
            return {"success": False, "error": f"AI Python not found at {AI_VENV_PYTHON}"}
        song_filename = (body.get("song_filename") or "").strip()
        if not song_filename:
            return {"success": False, "error": "song_filename is required"}
        # calibrate.py expects per-song taps file(s) under uploads/taps/.
        # Source of truth is shared uploads/taps.json, so materialize it here.
        taps_data = _read_json_file(TAPS_FILE, {})
        entry = taps_data.get(song_filename)
        if entry is None:
            # fallback: decode/normalize match in case caller sends encoded or variant name
            target = unquote(song_filename).strip().lower()
            for k, v in taps_data.items():
                if unquote(str(k)).strip().lower() == target:
                    entry = v
                    break
        if entry is None:
            return {"success": False, "error": f"No taps found for song '{song_filename}'"}
        _materialize_song_taps_file(song_filename, entry)

        # Ensure calibrate.py sees the same window settings as analysis:
        # - calibrate.py reads max_duration from env (MAX_DURATION)
        # - calibrate.py reads song_start_sec + focus flags from options.json
        env = os.environ.copy()
        try:
            with open(OPTIONS_FILE) as f:
                opts = json.load(f)
            env["MAX_DURATION"] = str(int(opts.get("max_duration", 60)))
            env["SONG_START_SEC"] = str(float(opts.get("song_start_sec", 0) or 0))
        except Exception:
            # Fall back to defaults; calibration can still run using options.json.
            env["MAX_DURATION"] = str(60)
        proc = subprocess.run(
            [str(AI_VENV_PYTHON), str(CALIBRATE_SCRIPT), song_filename],
            cwd=str(AI_DIR),
            env=env,
            capture_output=True,
            text=True,
            timeout=1800,
        )
        output = ((proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else "")).strip()
        if proc.returncode != 0:
            return {"success": False, "error": output or "Calibration failed"}
        return {"success": True, "output": output}
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Calibration timed out"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _normalize_segment_for_preview(seg: dict) -> dict:
    """Ensure segment has camelCase keys expected by frontend (same as export uses).
    Always include clipStart and clipEnd (clip in/out) so 'which part of the clip is used' is never lost."""
    start_time = float(seg.get("startTime", seg.get("start_time", 0)))
    end_time = float(seg.get("endTime", seg.get("end_time", 0)))
    segment_duration = max(0, end_time - start_time)
    clip_start = seg.get("clipStart", seg.get("clip_start"))
    clip_end = seg.get("clipEnd", seg.get("clip_end"))
    if clip_start is None:
        clip_start = 0.0
    else:
        clip_start = float(clip_start)
    if clip_end is None:
        clip_end = clip_start + segment_duration
    else:
        clip_end = float(clip_end)
    return {
        "startTime": start_time,
        "endTime": end_time,
        "clipFilename": str(seg.get("clipFilename", seg.get("clip_filename", ""))),
        "clipStart": clip_start,
        "clipEnd": clip_end,
    }


@app.post("/analyze")
async def analyze_only(body: Optional[dict] = Body(None)):
    """Run audio analysis only; compute segment list. Return JSON for preview. No ffmpeg.
    Body may include song_filename to force which song to analyze (must match a file in uploads/songs)."""
    try:
        print("[TRACE] POST /analyze received", "body=", body)
        if not AI_VENV_PYTHON.exists():
            return {"success": False, "error": f"AI Python not found at {AI_VENV_PYTHON}"}
        options_file = Path("uploads/options.json")
        if not options_file.exists():
            return {"success": False, "error": "options.json not found. Upload song first."}
        with open(options_file) as f:
            options = json.load(f)
        print("[TRACE] options.json BEFORE lock:", {k: v for k, v in options.items()})
        songs_dir = Path("uploads/songs")
        # Include all files (uploaded names may have no extension, e.g. "Tiktok Kesha" or "Tiktok%20Kesha")
        existing_songs = [f.name for f in songs_dir.iterdir() if f.is_file()] if songs_dir.exists() else []
        print("[TRACE] files in uploads/songs:", existing_songs)
        # If client sent song_filename, lock analysis to that song (avoid using stale/cached cut data from another track)
        requested_song = body.get("song_filename") if body else None
        if requested_song:
            if songs_dir.exists():
                # Match with URL-decode: options may have "Tiktok%20Kesha", client sends "Tiktok Kesha"
                def norm(s: str) -> str:
                    return unquote(str(s)).strip().lower()
                requested_norm = norm(requested_song)
                if requested_song in existing_songs:
                    options["song_filename"] = requested_song
                    with open(options_file, "w") as f:
                        json.dump(options, f, indent=2)
                    print("[TRACE] locked options.song_filename to (exact match):", requested_song)
                else:
                    match = next((n for n in existing_songs if norm(n) == requested_norm), None)
                    if match:
                        options["song_filename"] = match
                        with open(options_file, "w") as f:
                            json.dump(options, f, indent=2)
                        print("[TRACE] locked options.song_filename to (normalized match):", match, "requested:", requested_song)
                    else:
                        print("[TRACE] requested_song not in folder, options unchanged; requested:", requested_song)
        print("[TRACE] options.json AFTER lock:", {k: v for k, v in options.items()})
        if body and body.get("song_start_sec") is not None:
            try:
                options["song_start_sec"] = max(0.0, float(body["song_start_sec"]))
            except (TypeError, ValueError):
                options["song_start_sec"] = 0.0
            with open(options_file, "w") as f:
                json.dump(options, f, indent=2)
            print("[TRACE] merged body.song_start_sec into options:", options.get("song_start_sec"))
        max_duration = int(options.get("max_duration", 60))
        env = os.environ.copy()
        env["MAX_DURATION"] = str(max_duration)
        env["SONG_START_SEC"] = str(float(options.get("song_start_sec", 0) or 0))
        # Prefer request tap_mode over options.json to avoid stale mode.
        requested_tap_mode = (body or {}).get("tap_mode", None)
        if requested_tap_mode in ("verbatim", "calibrate"):
            env["TAP_MODE"] = requested_tap_mode
        else:
            env["TAP_MODE"] = ""
        # Ensure per-song tap files are fresh before running analyze.py.
        song_for_taps = options.get("song_filename")
        if song_for_taps:
            taps_data = _read_json_file(TAPS_FILE, {})
            taps_entry = taps_data.get(song_for_taps)
            if taps_entry is None:
                target = unquote(str(song_for_taps)).strip().lower()
                for k, v in taps_data.items():
                    if unquote(str(k)).strip().lower() == target:
                        taps_entry = v
                        break
            if taps_entry is not None:
                _materialize_song_taps_file(song_for_taps, taps_entry)

        # If user selected Calibrate AI cut mode, run calibrate.py first so
        # analyze.py can immediately use the freshly-updated calibration.json.
        if requested_tap_mode == "calibrate":
            song_filename_for_cal = options.get("song_filename")
            if not song_filename_for_cal:
                return {"success": False, "error": "song_filename missing; cannot calibrate"}
            print(f"[TRACE] tap_mode=calibrate; running calibrate.py for {song_filename_for_cal!r} ...")
            proc_cal = subprocess.run(
                [str(AI_VENV_PYTHON), str(CALIBRATE_SCRIPT), song_filename_for_cal],
                cwd=str(AI_DIR),
                env=env,
                capture_output=True,
                text=True,
                timeout=1800,
            )
            if proc_cal.returncode != 0:
                cal_out = ((proc_cal.stdout or "") + ("\n" + proc_cal.stderr if proc_cal.stderr else "")).strip()
                print("[TRACE] calibrate.py stderr:", (proc_cal.stderr or "")[:800])
                return {"success": False, "error": cal_out or "Calibration failed"}

        # 1) Run analyze.py
        print("[TRACE] running analyze.py (cwd=%s) ..." % AI_DIR)
        proc = subprocess.run(
            [str(AI_VENV_PYTHON), str(ANALYZE_SCRIPT)],
            cwd=str(AI_DIR),
            env=env,
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            print("[TRACE] analyze.py stderr:", (proc.stderr or "")[:800])
            print("[TRACE] analyze.py stdout:", (proc.stdout or "")[:800])
            return {"success": False, "error": f"analyze failed: {(proc.stderr or proc.stdout or '')[:500]}"}
        print("[TRACE] analyze.py exit 0; running compute_segments.py ...")
        # 2) Run compute_segments.py (writes uploads/analyze_result.json and uploads/segments.json)
        # Pass same window vars as analyze (clip_maker MAX_DURATION import reads env at import time).
        seg_env = os.environ.copy()
        seg_env["MAX_DURATION"] = str(max_duration)
        seg_env["SONG_START_SEC"] = str(float(options.get("song_start_sec", 0) or 0))
        proc2 = subprocess.run(
            [str(AI_VENV_PYTHON), str(COMPUTE_SEGMENTS_SCRIPT)],
            cwd=str(AI_DIR),
            env=seg_env,
            capture_output=True,
            text=True,
        )
        if proc2.returncode != 0:
            print("[TRACE] compute_segments.py stderr:", (proc2.stderr or "")[:800])
            print("[TRACE] compute_segments.py stdout:", (proc2.stdout or "")[:800])
            return {"success": False, "error": f"compute_segments failed: {(proc2.stderr or proc2.stdout or '')[:500]}"}
        if not ANALYZE_RESULT_FILE.exists():
            return {"success": False, "error": "analyze_result.json not written"}
        with open(ANALYZE_RESULT_FILE) as f:
            data = json.load(f)
        print("[TRACE] read analyze_result.json: duration=%s bpm=%s segments=%s first_cut=%s" % (
            data.get("duration"), data.get("bpm"), len(data.get("segments") or []),
            (data.get("cut_points") or [None])[0],
        ))
        # Normalize segments to exact format preview expects (camelCase, same as segments.json for export)
        raw_segments = data.get("segments") or []
        segments = [_normalize_segment_for_preview(s) for s in raw_segments]
        payload = {
            "success": True,
            "duration": data.get("duration", 0),
            "max_duration": data.get("max_duration", max_duration),
            "bpm": data.get("bpm", 0),
            "song_start_sec": float(data.get("song_start_sec", options.get("song_start_sec", 0)) or 0),
            "cut_points": data.get("cut_points") or [],
            "segments": segments,
        }
        # Save exact payload sent to client for debugging (compare with segments.json / export result)
        try:
            with open(ANALYZE_RESULT_FOR_PREVIEW_FILE, "w") as out:
                json.dump(payload, out, indent=2)
            print(f"Wrote {ANALYZE_RESULT_FOR_PREVIEW_FILE} ({len(segments)} segments)")
        except Exception as e:
            print(f"Could not write preview debug file: {e}")
        return payload
    except Exception as e:
        return {"success": False, "error": str(e)}


@app.get("/analyze-result-for-preview")
async def get_analyze_result_for_preview():
    """Return the last payload written for preview (for debugging). Compare with segments.json."""
    if not ANALYZE_RESULT_FOR_PREVIEW_FILE.exists():
        return {"error": "No preview payload yet. Call POST /analyze first."}
    with open(ANALYZE_RESULT_FOR_PREVIEW_FILE) as f:
        return json.load(f)


@app.post("/export")
async def export_video(body: Optional[dict] = Body(None)):
    """Run clip_maker (ffmpeg). Uses segments from request body if provided, else stored segments.json."""
    try:
        raw_segments = (body or {}).get("segments") or []
        seg_count = len(raw_segments)
        print(f"[TRACE] /export received: body_keys={list((body or {}).keys())}, segments_count={seg_count}")
        if raw_segments:
            total_from_segments = raw_segments[-1].get("endTime", raw_segments[-1].get("end_time"))
            print(f"[TRACE] /export total duration from last segment endTime: {total_from_segments}")
            for i, s in enumerate(raw_segments):
                st = s.get("startTime", s.get("start_time"))
                et = s.get("endTime", s.get("end_time"))
                cs = s.get("clipStart", s.get("clip_start"))
                ce = s.get("clipEnd", s.get("clip_end"))
                fn = s.get("clipFilename", s.get("clip_filename"))
                print(f"[TRACE] /export segment[{i}]: startTime={st}, endTime={et}, clipStart={cs}, clipEnd={ce}, clipFilename={fn}")
        if not AI_VENV_PYTHON.exists():
            return {"success": False, "error": f"AI Python not found at {AI_VENV_PYTHON}"}
        segments_file = Path("uploads/segments.json")
        if body and body.get("segments"):
            raw = body["segments"]
            normalized = [_normalize_segment_for_preview(s) for s in raw]
            with open(segments_file, "w") as f:
                json.dump(normalized, f, indent=2)
            print(f"[TRACE] /export wrote segments.json: {len(normalized)} segments, path={segments_file.absolute()}")
            if normalized:
                n0 = normalized[0]
                print(f"[TRACE] /export segments.json first: startTime={n0['startTime']}, endTime={n0['endTime']}, clipStart={n0['clipStart']}, clipEnd={n0['clipEnd']}")
        else:
            print(f"[TRACE] /export NOT writing segments (no body or no segments); using existing segments.json")
        if not segments_file.exists():
            return {"success": False, "error": "segments.json not found. Call POST /analyze first or send segments in body."}
        env = os.environ.copy()
        with open(Path("uploads/options.json")) as f:
            opts = json.load(f)
        env["MAX_DURATION"] = str(opts.get("max_duration", 60))
        env["SONG_START_SEC"] = str(float(opts.get("song_start_sec", 0) or 0))
        final_videos_path = Path("uploads/final_videos")
        mtime_before = None
        if final_videos_path.exists():
            videos_before = [f for f in final_videos_path.iterdir() if f.is_file() and f.suffix.lower() == ".mp4"]
            if videos_before:
                mtime_before = max(f.stat().st_mtime for f in videos_before)
                print(f"[TRACE] /export mtime_before={mtime_before}")
        print(f"[TRACE] /export starting clip_maker (cwd={AI_DIR}) ...")
        process = subprocess.Popen(
            [str(AI_VENV_PYTHON), str(CLIP_MAKER_SCRIPT)],
            cwd=str(AI_DIR),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        for line in process.stdout:
            print(line, end="")
        process.wait()
        code = process.returncode
        print(f"[TRACE] /export clip_maker exited with code={code}")
        if code != 0:
            return {"success": False, "error": f"clip_maker exited with code {code}"}
        latest_video = None
        if final_videos_path.exists():
            videos = [f for f in final_videos_path.iterdir() if f.is_file() and f.suffix.lower() == ".mp4"]
            if videos:
                latest = max(videos, key=lambda x: x.stat().st_mtime)
                mtime_after = latest.stat().st_mtime
                if mtime_before is not None and mtime_after <= mtime_before:
                    print(f"[TRACE] /export no new video (mtime_after={mtime_after} <= mtime_before={mtime_before}); refusing to return stale file")
                    return {"success": False, "error": "Export did not produce a new video. Try analyzing again, then export."}
                latest_video = {"name": latest.name, "url": f"/files/final_videos/{latest.name}", "size": latest.stat().st_size}
                print(f"[TRACE] /export returning latest_video: name={latest.name}, mtime={mtime_after}, total_files={len(videos)}")
            else:
                print(f"[TRACE] /export final_videos dir empty, no video to return")
        else:
            print(f"[TRACE] /export final_videos path does not exist")
        return {"success": True, "final_video": latest_video}
    except Exception as e:
        print(f"[TRACE] /export exception: {e}")
        return {"success": False, "error": str(e)}


@app.post("/run_ai")
async def run_ai():
    """Run the full AI pipeline"""
    try:
        print("✅ /run_ai endpoint triggered")

        if not AI_VENV_PYTHON.exists():
            return {"success": False, "error": f"AI Python not found at {AI_VENV_PYTHON}"}

        # Start subprocess with live stdout/stderr streaming
        process = subprocess.Popen(
            [str(AI_VENV_PYTHON), str(MAIN_AI_SCRIPT)],
            cwd=MAIN_AI_SCRIPT.parent,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True
        )

        # Stream output line by line
        for line in process.stdout:
            print(line, end="")

        process.wait()
        retcode = process.returncode

        if retcode != 0:
            return {"success": False, "error": f"AI process exited with code {retcode}"}

        # Locate latest final video
        final_videos_path = Path("uploads/final_videos")
        latest_video = None
        if final_videos_path.exists():
            videos = [f for f in final_videos_path.iterdir() if f.is_file() and f.suffix.lower() == ".mp4"]
            if videos:
                latest_video_file = max(videos, key=lambda x: x.stat().st_mtime)
                latest_video = {
                    "name": latest_video_file.name,
                    "url": f"/files/final_videos/{latest_video_file.name}",
                    "size": latest_video_file.stat().st_size
                }

        return {"success": True, "final_video": latest_video}

    except Exception as e:
        return {"success": False, "error": str(e)}

# -------------------------
# GET LATEST FINAL VIDEO
# -------------------------
@app.get("/latest-video")
async def get_latest_video():
    """Get the latest generated final video"""
    final_videos_path = Path("uploads/final_videos")
    
    if not final_videos_path.exists():
        return {"found": False, "message": "No final videos folder exists"}
    
    videos = [f for f in final_videos_path.iterdir() 
             if f.is_file() and f.suffix.lower() == '.mp4']
    
    if not videos:
        return {"found": False, "message": "No final videos found"}
    
    latest_video_file = max(videos, key=lambda x: x.stat().st_mtime)
    
    return {
        "found": True,
        "name": latest_video_file.name,
        "url": f"/files/final_videos/{latest_video_file.name}",
        "size": latest_video_file.stat().st_size,
        "modified": latest_video_file.stat().st_mtime
    }

# -------------------------
# DOWNLOAD ENDPOINT
# -------------------------
@app.get("/download/final_videos/{filename}")
async def download_video(filename: str):
    """Direct download endpoint for final videos"""
    file_path = Path(f"uploads/final_videos/{filename}")
    
    if not file_path.exists():
        return {"error": "File not found", "filename": filename}
    
    return FileResponse(
        path=str(file_path),
        media_type="video/mp4",
        filename=filename
    )

# -------------------------
# LIST FILES
# -------------------------
@app.get("/list-files")
async def list_files():
    media_files = []
    song_files = []
    final_videos = []
    image_ext = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif']
    video_ext = ['.mp4', '.mov', '.m4v', '.avi', '.mkv']

    for item in Path("uploads/media").iterdir():
        if item.is_file():
            ext = item.suffix.lower()
            file_type = "image" if ext in image_ext else "video"
            media_files.append({
                "name": item.name,
                "size": item.stat().st_size,
                "type": file_type,
                "url": f"/files/media/{item.name}"
            })

    for item in Path("uploads/songs").iterdir():
        if item.is_file():
            song_files.append({
                "name": item.name,
                "size": item.stat().st_size,
                "url": f"/files/songs/{item.name}"
            })
    
    # List final videos
    for item in Path("uploads/final_videos").iterdir():
        if item.is_file() and item.suffix.lower() in video_ext:
            final_videos.append({
                "name": item.name,
                "size": item.stat().st_size,
                "url": f"/files/final_videos/{item.name}",
                "modified": item.stat().st_mtime
            })
    
    final_videos.sort(key=lambda x: x['modified'], reverse=True)

    return {
        "media": media_files, 
        "songs": song_files, 
        "final_videos": final_videos,
        "total": len(media_files) + len(song_files) + len(final_videos)
    }

# -------------------------
# CLEAN & MODERN HTML VIEWER
# -------------------------
@app.get("/viewer", response_class=HTMLResponse)
async def viewer():
    media_files = []
    song_files = []
    image_ext = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif']
    video_ext = ['.mp4', '.mov', '.m4v', '.avi', '.mkv']

    # Get media files
    for item in Path("uploads/media").iterdir():
        if item.is_file():
            ext = item.suffix.lower()
            file_type = "image" if ext in image_ext else "video"
            media_files.append({
                "name": item.name, 
                "type": file_type, 
                "url": f"/files/media/{item.name}"
            })

    for item in Path("uploads/songs").iterdir():
        if item.is_file():
            song_files.append({"name": item.name, "url": f"/files/songs/{item.name}"})

    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
    <title>Media Gallery</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * {{ box-sizing: border-box; margin: 0; padding: 0; }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }}
        .container {{
            max-width: 1400px;
            margin: 0 auto;
        }}
        header {{
            text-align: center;
            color: white;
            margin-bottom: 40px;
            padding: 40px 20px;
        }}
        h1 {{
            font-size: 48px;
            font-weight: 800;
            margin-bottom: 12px;
            text-shadow: 0 2px 10px rgba(0,0,0,0.2);
        }}
        .subtitle {{
            font-size: 18px;
            opacity: 0.95;
            font-weight: 500;
        }}
        .section {{
            background: white;
            border-radius: 24px;
            padding: 32px;
            margin-bottom: 24px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.1);
        }}
        h2 {{
            font-size: 24px;
            font-weight: 700;
            color: #1a1a1a;
            margin-bottom: 24px;
            display: flex;
            align-items: center;
            gap: 10px;
        }}
        .count-badge {{
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 14px;
            font-weight: 600;
        }}
        .grid {{ 
            display: grid; 
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); 
            gap: 24px;
        }}
        .item {{ 
            background: #f8f9fa;
            border-radius: 20px;
            overflow: hidden;
            transition: all 0.3s ease;
            cursor: pointer;
            position: relative;
        }}
        .item:hover {{ 
            transform: translateY(-8px); 
            box-shadow: 0 20px 40px rgba(102, 126, 234, 0.3);
        }}
        .item img, .item video {{ 
            width: 100%; 
            height: 320px; 
            object-fit: cover; 
            display: block;
            background: linear-gradient(135deg, #e9ecef 0%, #dee2e6 100%);
        }}
        .name {{ 
            padding: 16px 20px; 
            font-size: 14px; 
            font-weight: 600;
            word-break: break-word;
            color: #495057;
            background: white;
        }}
        .type-badge {{
            position: absolute;
            top: 12px;
            right: 12px;
            background: rgba(0, 0, 0, 0.75);
            backdrop-filter: blur(10px);
            color: white;
            padding: 6px 12px;
            border-radius: 8px;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.5px;
        }}
        audio {{ 
            width: 100%;
            margin-top: 12px;
        }}
        .audio-item {{
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 20px;
            padding: 24px;
            color: white;
            transition: all 0.3s ease;
        }}
        .audio-item:hover {{
            transform: translateY(-4px);
            box-shadow: 0 20px 40px rgba(102, 126, 234, 0.4);
        }}
        .audio-item .name {{
            color: white;
            background: transparent;
            font-size: 16px;
            padding: 0 0 12px 0;
        }}
        .empty {{
            text-align: center;
            padding: 80px 40px;
            color: #adb5bd;
            font-size: 16px;
            font-weight: 500;
        }}
        .empty-icon {{
            font-size: 64px;
            margin-bottom: 16px;
            opacity: 0.5;
        }}
        .error-img {{
            background: linear-gradient(135deg, #f8d7da 0%, #f5c2c7 100%);
            color: #721c24;
            padding: 40px 20px;
            text-align: center;
            font-weight: 600;
        }}
        video::-webkit-media-controls {{
            filter: brightness(1.1);
        }}
        @media (max-width: 768px) {{
            h1 {{ font-size: 36px; }}
            .grid {{ grid-template-columns: 1fr; }}
            .section {{ padding: 20px; }}
        }}
    </style>
    <script>
        function handleImageError(img) {{
            img.parentElement.innerHTML = '<div class="error-img"><div class="empty-icon">⚠️</div>Failed to load image<br><small>' + img.alt + '</small></div>';
        }}
    </script>
    </head>
    <body>
        <div class="container">
            <header>
                <h1>📸 Media Gallery</h1>
                <div class="subtitle">Your uploaded content</div>
            </header>

            <div class="section">
                <h2>
                    Images & Videos 
                    <span class="count-badge">{len(media_files)}</span>
                </h2>
                <div class="grid">
    """

    if media_files:
        for m in media_files:
            if m["type"] == "image":
                html += f'''<div class="item">
                    <span class="type-badge">PHOTO</span>
                    <img src="{m["url"]}" alt="{m["name"]}" loading="lazy" onerror="handleImageError(this)">
                    <div class="name">📷 {m["name"]}</div>
                </div>'''
            else:
                html += f'''<div class="item">
                    <span class="type-badge">VIDEO</span>
                    <video controls preload="metadata">
                        <source src="{m["url"]}" type="video/mp4">
                        <source src="{m["url"]}" type="video/quicktime">
                        Your browser does not support video playback.
                    </video>
                    <div class="name">🎬 {m["name"]}</div>
                </div>'''
    else:
        html += '<div class="empty"><div class="empty-icon">🎬</div>No media uploaded yet</div>'

    html += f'''</div>
            </div>

            <div class="section">
                <h2>
                    Songs 
                    <span class="count-badge">{len(song_files)}</span>
                </h2>
                <div class="grid">'''

    if song_files:
        for s in song_files:
            html += f'''<div class="audio-item">
                <div class="name">🎵 {s["name"]}</div>
                <audio controls src="{s["url"]}">Your browser does not support audio playback.</audio>
            </div>'''
    else:
        html += '<div class="empty"><div class="empty-icon">🎵</div>No songs uploaded yet</div>'

    html += """
                </div>
            </div>
        </div>
    </body>
    </html>
    """

    return HTMLResponse(content=html)

# -------------------------
# ROOT
# -------------------------
@app.get("/")
async def root():
    return {"message": "Backend running! Visit /viewer to see uploaded files"}