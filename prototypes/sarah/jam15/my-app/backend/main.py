from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
import os
import shutil
from typing import List, Optional
from pathlib import Path
from PIL import Image
from pillow_heif import register_heif_opener

# Enable HEIC/HEIF support
register_heif_opener()

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

# Static folders
app.mount("/files/media", StaticFiles(directory="uploads/media"), name="media")
app.mount("/files/songs", StaticFiles(directory="uploads/songs"), name="songs")

# -------------------------
# HEIC/HEIF -> JPEG
# -------------------------
def convert_heic_to_jpg(file_path: str) -> str:
    try:
        img = Image.open(file_path)
        if img.mode in ('RGBA', 'LA', 'P'):
            img = img.convert('RGB')
        jpg_path = file_path.rsplit('.', 1)[0] + '.jpg'
        img.save(jpg_path, 'JPEG', quality=95)
        if os.path.exists(file_path) and file_path != jpg_path:
            os.remove(file_path)
        return jpg_path
    except Exception as e:
        print(f"Error converting HEIC {file_path}: {e}")
        return file_path

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
        with open(save_path, "wb") as buffer:
            shutil.copyfileobj(f.file, buffer)
        
        # Convert HEIC/HEIF to JPG automatically
        if save_path.lower().endswith(('.heic', '.heif')):
            save_path = convert_heic_to_jpg(save_path)
        
        # Generate thumbnail if video
        if save_path.lower().endswith(('.mp4', '.mov', '.m4v', '.avi', '.mkv')):
            generate_video_thumbnail(save_path)
    
    # Use the final path after conversion
    saved_files.append(Path(save_path).name)


    song_saved = None
    if song:
        song_path = f"uploads/songs/{song.filename}"
        with open(song_path, "wb") as buffer:
            shutil.copyfileobj(song.file, buffer)
        song_saved = song.filename

    return {"files_saved": saved_files, "song_saved": song_saved}

# -------------------------
# LIST FILES
# -------------------------
@app.get("/list-files")
async def list_files():
    media_files = []
    song_files = []
    image_ext = ['.jpg', '.jpeg', '.png', '.gif', '.webp']
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

    return {"media": media_files, "songs": song_files, "total": len(media_files) + len(song_files)}

# -------------------------
# CLEAN & MODERN HTML VIEWER
# -------------------------
@app.get("/viewer", response_class=HTMLResponse)
async def viewer():
    media_files = []
    song_files = []
    image_ext = ['.jpg', '.jpeg', '.png', '.gif', '.webp']
    video_ext = ['.mp4', '.mov', '.m4v', '.avi', '.mkv']

    for item in Path("uploads/media").iterdir():
        if item.is_file():
            ext = item.suffix.lower()
            file_type = "image" if ext in image_ext else "video"
            media_files.append({"name": item.name, "type": file_type, "url": f"/files/media/{item.name}"})

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
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            margin:0; padding:20px; background:#f0f0f0;
        }}
        h1 {{ text-align:center; }}
        .grid {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:20px; }}
        .item {{ background:white; border-radius:12px; overflow:hidden; box-shadow:0 4px 6px rgba(0,0,0,0.1); }}
        .item img, .item video {{ width:100%; height:280px; object-fit:cover; }}
        .name {{ padding:10px; font-size:14px; word-break:break-word; }}
        audio {{ width:100%; margin-top:10px; }}
    </style>
    </head>
    <body>
        <h1>📸 Media Gallery</h1>
        <h2>Images & Videos ({len(media_files)})</h2>
        <div class="grid">
    """

    if media_files:
        for m in media_files:
            if m["type"] == "image":
                html += f'<div class="item"><img src="{m["url"]}" alt="{m["name"]}"><div class="name">📷 {m["name"]}</div></div>'
            else:
                html += f'<div class="item"><video controls preload="metadata"><source src="{m["url"]}" type="video/mp4"><source src="{m["url"]}" type="video/quicktime"></video><div class="name">🎬 {m["name"]}</div></div>'
    else:
        html += '<div>No media uploaded</div>'

    html += "</div><h2>Songs ({len(song_files)})</h2><div class='grid'>"

    if song_files:
        for s in song_files:
            html += f'<div class="item"><div class="name">🎵 {s["name"]}</div><audio controls src="{s["url"]}"></audio></div>'
    else:
        html += '<div>No songs uploaded</div>'

    html += "</div></body></html>"

    return HTMLResponse(content=html)

# -------------------------
# ROOT
# -------------------------
@app.get("/")
async def root():
    return {"message": "Backend running! Visit /viewer to see uploaded files"}
