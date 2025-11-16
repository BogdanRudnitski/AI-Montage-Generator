from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
import os
import shutil
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
# VIDEO CONVERSION (NO THUMBNAILS)
# -------------------------
def convert_video_to_h264(video_path: str) -> str:
    """Convert video to H.264 for better browser compatibility"""
    try:
        # Check if video is already H.264
        probe = subprocess.run([
            'ffprobe',
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            video_path
        ], capture_output=True, text=True)
        
        codec = probe.stdout.strip()
        print(f"Video codec: {codec}")
        
        # If already H.264, no conversion needed
        if codec == 'h264':
            print(f"✓ Video already H.264: {video_path}")
            return video_path
        
        # Convert to H.264
        print(f"Converting {codec} to H.264: {video_path}")
        output_path = video_path.rsplit('.', 1)[0] + '_converted.mp4'
        
        subprocess.run([
            'ffmpeg',
            '-i', video_path,
            '-c:v', 'libx264',
            '-preset', 'medium',
            '-crf', '23',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            '-y',
            output_path
        ], check=True, capture_output=True)
        
        print(f"✓ Converted to H.264: {output_path}")
        
        # Remove original and rename converted file
        if os.path.exists(output_path):
            os.remove(video_path)
            final_path = video_path.rsplit('.', 1)[0] + '.mp4'
            os.rename(output_path, final_path)
            print(f"✓ Replaced with: {final_path}")
            return final_path
        
        return video_path
        
    except FileNotFoundError:
        print("Warning: ffmpeg/ffprobe not found. Install to enable video conversion.")
        return video_path
    except Exception as e:
        print(f"Warning: Could not convert video {video_path}: {e}")
        return video_path

# -------------------------
# UPLOAD - CLEAR OLD FILES
# -------------------------
@app.post("/upload")
async def upload_media(
    files: List[UploadFile] = File(...),
    song: Optional[UploadFile] = File(None)
):
    # Clear previous uploads
    shutil.rmtree("uploads/media", ignore_errors=True)
    shutil.rmtree("uploads/songs", ignore_errors=True)
    os.makedirs("uploads/media", exist_ok=True)
    os.makedirs("uploads/songs", exist_ok=True)

    saved_files = []

    for f in files:
        save_path = f"uploads/media/{f.filename}"
        
        # Save the uploaded file
        with open(save_path, "wb") as buffer:
            shutil.copyfileobj(f.file, buffer)
        
        print(f"Saved: {save_path}")
        
        # Convert videos to H.264 (NO THUMBNAIL GENERATION)
        if save_path.lower().endswith(('.mp4', '.mov', '.m4v', '.avi', '.mkv')):
            save_path = convert_video_to_h264(save_path)
        
        # Use the final path after conversion
        saved_files.append(Path(save_path).name)

    song_saved = None
    if song:
        song_path = f"uploads/songs/{song.filename}"
        with open(song_path, "wb") as buffer:
            shutil.copyfileobj(song.file, buffer)
        song_saved = song.filename
        print(f"Saved song: {song_path}")

    print(f"Total files saved: {saved_files}")
    return {"files_saved": saved_files, "song_saved": song_saved}

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
        * {{ box-sizing: border-box; }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            margin:0; padding:20px; background:#f8f9fa;
        }}
        h1 {{ text-align:center; color:#333; }}
        h2 {{ color:#555; margin-top:30px; }}
        .grid {{ 
            display:grid; 
            grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); 
            gap:20px; 
            margin-top:20px;
        }}
        .item {{ 
            background:white; 
            border-radius:16px; 
            overflow:hidden; 
            box-shadow:0 2px 8px rgba(0,0,0,0.1);
            transition: transform 0.2s;
        }}
        .item:hover {{ transform: translateY(-4px); box-shadow:0 4px 12px rgba(0,0,0,0.15); }}
        .item img, .item video {{ 
            width:100%; 
            height:280px; 
            object-fit:cover; 
            display:block;
            background:#e9ecef;
        }}
        .name {{ 
            padding:12px 16px; 
            font-size:14px; 
            word-break:break-word;
            color:#495057;
            border-top: 1px solid #e9ecef;
        }}
        audio {{ 
            width:100%; 
            margin-top:10px;
            padding: 0 16px 16px;
        }}
        .empty {{
            text-align:center;
            padding:40px;
            color:#adb5bd;
            font-style:italic;
        }}
        .error-img {{
            background:#f8d7da;
            color:#721c24;
            padding:20px;
            text-align:center;
        }}
    </style>
    <script>
        function handleImageError(img) {{
            img.parentElement.innerHTML = '<div class="error-img">⚠️ Failed to load image<br><small>' + img.alt + '</small></div>';
        }}
    </script>
    </head>
    <body>
        <h1>📸 Media Gallery</h1>
        <h2>Images & Videos ({len(media_files)})</h2>
        <div class="grid">
    """

    if media_files:
        for m in media_files:
            if m["type"] == "image":
                html += f'''<div class="item">
                    <img src="{m["url"]}" alt="{m["name"]}" loading="lazy" onerror="handleImageError(this)">
                    <div class="name">📷 {m["name"]}</div>
                </div>'''
            else:
                html += f'''<div class="item">
                    <video controls preload="metadata">
                        <source src="{m["url"]}" type="video/mp4">
                        <source src="{m["url"]}" type="video/quicktime">
                        Your browser does not support video playback.
                    </video>
                    <div class="name">🎬 {m["name"]}</div>
                </div>'''
    else:
        html += '<div class="empty">No media uploaded yet</div>'

    html += f"</div><h2>Songs ({len(song_files)})</h2><div class='grid'>"

    if song_files:
        for s in song_files:
            html += f'''<div class="item">
                <div class="name">🎵 {s["name"]}</div>
                <audio controls src="{s["url"]}">Your browser does not support audio playback.</audio>
            </div>'''
    else:
        html += '<div class="empty">No songs uploaded yet</div>'

    html += """
        </div>
        <div style="height:40px;"></div>
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