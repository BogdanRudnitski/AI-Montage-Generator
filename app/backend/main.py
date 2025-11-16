from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
import os
import shutil
import json
import re
from typing import List, Optional
from pathlib import Path
import subprocess

app = FastAPI()

# Allow frontend access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Ensure upload directories exist
os.makedirs("uploads/media", exist_ok=True)
os.makedirs("uploads/songs", exist_ok=True)
os.makedirs("uploads/final_videos", exist_ok=True)

# Static folders
app.mount("/files/media", StaticFiles(directory="uploads/media"), name="media")
app.mount("/files/songs", StaticFiles(directory="uploads/songs"), name="songs")
app.mount("/files/final_videos", StaticFiles(directory="uploads/final_videos"), name="final_videos")

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
    """Clear all media files (not songs)"""
    try:
        shutil.rmtree("uploads/media", ignore_errors=True)
        os.makedirs("uploads/media", exist_ok=True)
        print("✓ Cleared uploads/media folder")
        return {"success": True, "message": "Media folder cleared"}
    except Exception as e:
        print(f"Error clearing uploads: {e}")
        return {"success": False, "error": str(e)}

# -------------------------
# UPLOAD SINGLE FILE
# -------------------------
@app.post("/upload-single")
async def upload_single_file(files: List[UploadFile] = File(...)):
    """Upload a single media file with compression"""
    saved_files = []
    
    for f in files:
        save_path = f"uploads/media/{f.filename}"
        
        # Save the uploaded file
        with open(save_path, "wb") as buffer:
            shutil.copyfileobj(f.file, buffer)
        
        print(f"Saved: {save_path}")
        
        # Compress videos (handles both compression and H.264 conversion)
        if save_path.lower().endswith(('.mp4', '.mov', '.m4v', '.avi', '.mkv')):
            save_path = compress_video(save_path)
        
        saved_files.append(Path(save_path).name)
    
    return {"success": True, "files_saved": saved_files}

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
    sync_to_grid: str = Form("false")
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
    
    # Save options.json with all parameters
    options_data = {
        "max_duration": int(max_duration),
        "density": density,
        "aggressiveness": float(aggressiveness),
        "focus_bass": parse_bool(focus_bass),
        "focus_vocals": parse_bool(focus_vocals),
        "focus_repetitions": parse_bool(focus_repetitions),
        "sync_to_grid": parse_bool(sync_to_grid),
        "song_filename": song.filename
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
# OLD UPLOAD ENDPOINT (KEPT FOR COMPATIBILITY)
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
    sync_to_grid: str = Form("false")
):
    # Clear previous uploads
    shutil.rmtree("uploads/media", ignore_errors=True)
    shutil.rmtree("uploads/songs", ignore_errors=True)
    os.makedirs("uploads/media", exist_ok=True)
    os.makedirs("uploads/songs", exist_ok=True)

    saved_files = []

    for f in files:
        # Sanitize the filename
        sanitized_name = sanitize_filename(f.filename)
        save_path = f"uploads/media/{sanitized_name}"
        
        print(f"Original filename: {f.filename}")
        print(f"Sanitized filename: {sanitized_name}")
        
        # Save the uploaded file
        with open(save_path, "wb") as buffer:
            shutil.copyfileobj(f.file, buffer)
        
        print(f"Saved: {save_path}")
        
        # Compress videos
        if save_path.lower().endswith(('.mp4', '.mov', '.m4v', '.avi', '.mkv')):
            save_path = compress_video(save_path)
        
        saved_files.append(Path(save_path).name)

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
    options_data = {
        "max_duration": int(max_duration),
        "density": density,
        "aggressiveness": float(aggressiveness),
        "focus_bass": parse_bool(focus_bass),
        "focus_vocals": parse_bool(focus_vocals),
        "focus_repetitions": parse_bool(focus_repetitions),
        "sync_to_grid": parse_bool(sync_to_grid),
    }
    if song_saved:
        options_data["song_filename"] = song_saved
        
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
# GENERATE CLIP
# -------------------------
MAIN_AI_SCRIPT = Path("../ai/main.py")
AI_VENV_PYTHON = Path("../ai/venv/bin/python3")

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