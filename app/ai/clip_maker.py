# clip_maker.py - ULTRA FAST video generation with ffmpeg direct processing
import json
import os
import random
import re
import librosa
import soundfile as sf
import subprocess
import numpy as np

from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent  # adjust if your FastAPI root is different

CLIPS_FOLDER = PROJECT_ROOT / "backend/uploads/media"
AUDIO_FOLDER = PROJECT_ROOT / "backend/uploads/songs"
OUTPUT_FOLDER = PROJECT_ROOT / "backend/uploads/final_videos"
ANALYSIS_JSON = SCRIPT_DIR / "audio_analysis.json"

# === CONFIGURATION ===
# Read MAX_DURATION from environment variable (set by main.py)
# Falls back to 60 if not set
MAX_DURATION = int(os.environ.get('MAX_DURATION', '60'))
# Change this to generate longer videos (e.g., 120 for 2 minutes, None for full song)

# Beat types that should trigger clip changes
BEAT_CHANGE_TYPES = {'bass_drop', 'vocal_change', 'downbeat'}

def sanitize_filename(filename: str) -> str:
    """Remove or replace problematic characters in filenames"""
    # Keep the extension
    name, ext = os.path.splitext(filename)
    
    # Make sure extension is lowercase and valid
    ext = ext.lower()
    
    # Replace spaces and hyphens with underscores
    name = name.replace(' ', '_')
    name = name.replace('-', '_')
    
    # Remove or replace special characters, keep only alphanumeric and underscore
    name = re.sub(r'[^\w]', '', name)
    
    # Remove multiple consecutive underscores
    name = re.sub(r'_+', '_', name)
    
    # Remove leading/trailing underscores
    name = name.strip('_')
    
    # Make sure we have a name
    if not name:
        name = "video"
    
    # Limit length
    if len(name) > 100:
        name = name[:100]
    
    return name + ext

class ClipManager:
    """Manages video clips and tracks used segments to avoid repetition"""
    
    def __init__(self, clips_folder):
        self.clips_folder = clips_folder
        self.clips = []
        self.clip_usage = {}
        self.last_used_clip = None
        self.load_clips()
    
    def load_clips(self):
        """Load all video clips metadata (no actual loading for speed)"""
        if not os.path.exists(self.clips_folder):
            print(f"❌ '{self.clips_folder}' folder not found!")
            return
        
        video_files = [f for f in os.listdir(self.clips_folder) 
                      if f.lower().endswith(('.mp4', '.mov', '.avi', '.mkv', '.webm'))]
        
        print(f"🔍 Scanning clips from '{self.clips_folder}'...")
        for video_file in video_files:
            path = os.path.join(self.clips_folder, video_file)
            try:
                # Get duration using ffprobe (fast)
                result = subprocess.run([
                    'ffprobe', '-v', 'error', '-show_entries', 
                    'format=duration', '-of', 
                    'default=noprint_wrappers=1:nokey=1', path
                ], capture_output=True, text=True)
                
                duration = float(result.stdout.strip())
                
                self.clips.append({
                    'path': path,
                    'filename': video_file,
                    'duration': duration
                })
                self.clip_usage[video_file] = []
                print(f"   ✅ {video_file} ({duration:.2f}s)")
            except Exception as e:
                print(f"   ❌ Failed to scan {video_file}: {e}")
        
        print(f"\n📊 Loaded {len(self.clips)} clips\n")
    
    def get_segment_info(self, duration, force_new_clip=False):
        """Get info about which clip and segment to use (no actual clip loading)"""
        if not self.clips:
            return None
        
        # If we need to force a new clip (for beat drops)
        if force_new_clip and len(self.clips) > 1:
            available_clips = [c for c in self.clips if c['filename'] != self.last_used_clip]
            if available_clips:
                clip_data = random.choice(available_clips)
            else:
                clip_data = random.choice(self.clips)
        else:
            clip_data = random.choice(self.clips)
        
        clip_duration = clip_data['duration']
        filename = clip_data['filename']
        
        # Try to find unused segment
        used_segments = self.clip_usage[filename]
        
        start_time = 0
        found_unused = False
        
        if clip_duration >= duration:
            # Try to find unused segment
            for _ in range(10):
                max_start = clip_duration - duration
                start = random.uniform(0, max_start)
                end = start + duration
                
                # Check if this overlaps with used segments
                is_unused = True
                for used_start, used_end in used_segments:
                    if not (end <= used_start or start >= used_end):
                        is_unused = False
                        break
                
                if is_unused:
                    start_time = start
                    found_unused = True
                    self.clip_usage[filename].append((start, end))
                    break
            
            if not found_unused:
                # Just use random segment
                start_time = random.uniform(0, max_start)
                self.clip_usage[filename].append((start_time, start_time + duration))
        else:
            # Clip is shorter, we'll loop it
            start_time = 0
        
        self.last_used_clip = filename
        
        return {
            'path': clip_data['path'],
            'filename': filename,
            'start': start_time,
            'duration': duration,
            'clip_duration': clip_duration
        }

def create_video_ultrafast(audio_path, cut_points, clip_manager, output_path, max_duration=None):
    """Create video using direct ffmpeg processing but re-encoding to avoid freezes."""
    print(f"\n🎬 Creating video (stable output, re-encoding to avoid freezes)...")
    print(f"   Audio: {os.path.basename(audio_path)}")
    print(f"   Cut points: {len(cut_points)}")

    # Sort cut points by timestamp
    cut_points = sorted(cut_points, key=lambda x: x['timestamp'])

    # Audio load (librosa)
    y, sr = librosa.load(audio_path, sr=44100, mono=False)
    full_duration = librosa.get_duration(y=y, sr=sr)

    # Apply max duration limit
    if max_duration and max_duration > 0:
        duration = min(max_duration, full_duration)
        if duration < full_duration:
            max_samples = int(duration * sr)
            if y.ndim == 1:
                y = y[:max_samples]
            else:
                y = y[:, :max_samples]
            temp_audio = "temp_trimmed_audio.wav"
            sf.write(temp_audio, y.T if y.ndim > 1 else y, sr)
            audio_path = temp_audio
            print(f"   ⏱️  Generating {duration:.2f}s video (trimmed from {full_duration:.2f}s)\n")
        else:
            print(f"   Duration: {duration:.2f}s\n")
    else:
        duration = full_duration
        print(f"   Duration: {duration:.2f}s\n")

    # Filter cut points to only those within duration
    cut_points = [p for p in cut_points if p['timestamp'] < duration]

    # Build timestamps array (segments between points)
    timestamps = [{'timestamp': 0, 'type': 'start', 'score': 0}] + cut_points + [{'timestamp': duration, 'type': 'end', 'score': 0}]
    print(f"⚡ Generating {len(timestamps)-1} segments...")

    # Temp folder
    temp_folder = "temp_segments"
    os.makedirs(temp_folder, exist_ok=True)

    segment_files = []
    concat_list = []

    # Configurable quality / speed params (tune if needed)
    TARGET_FPS = 30
    PRESET = "veryfast"      # keep faster presets; set to "fast" or "medium" for quality
    CRF = 20                 # 18-23 is typical; lower => better quality, larger files
    GOP = TARGET_FPS * 1     # keyframe every ~1s
    KEYINT_MIN = TARGET_FPS  # minimum keyframe interval
    # NOTE: keep crf/preset small for speed during development, increase quality later.

    for i in range(len(timestamps) - 1):
        start_time = timestamps[i]['timestamp']
        end_time = timestamps[i + 1]['timestamp']
        segment_duration = end_time - start_time

        current_point = timestamps[i + 1]
        force_new_clip = current_point['type'] in BEAT_CHANGE_TYPES and current_point.get('score', 0) >= 20

        if force_new_clip:
            print(f"   🎵 Beat drop at {current_point['timestamp']:.2f}s - forcing new clip!")

        segment_info = clip_manager.get_segment_info(segment_duration, force_new_clip=force_new_clip)
        if not segment_info:
            continue

        segment_output = os.path.join(temp_folder, f"segment_{i:04d}.mp4")
        clip_path = segment_info['path']
        clip_start = segment_info['start']
        clip_duration = segment_info['clip_duration']

        # If clip is shorter than needed, use ffmpeg -stream_loop to repeat the file,
        # then trim to exact duration while re-encoding with constant fps and controlled GOP.
        if clip_duration < segment_duration:
            # Number of loops needed (stream_loop repeats N times after the first play)
            num_loops = int(np.ceil(segment_duration / clip_duration))
            stream_loop_count = max(0, num_loops - 1)

            cmd = [
                'ffmpeg',
                '-y',
                '-stream_loop', str(stream_loop_count),
                '-i', clip_path,
                '-t', str(segment_duration),
                '-vf', f"fps={TARGET_FPS},scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
                '-c:v', 'libx264',
                '-preset', PRESET,
                '-crf', str(CRF),
                '-g', str(GOP),
                '-keyint_min', str(KEYINT_MIN),
                '-sc_threshold', '0',   # disable scene cut detection for stable keyframes
                '-an',
                segment_output
            ]

            subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            # Extract segment from clip with frame-accurate cut: place -ss AFTER -i for accurate decoding,
            # re-encode to enforce CFR and predictable GOPs.
            # Note: placing -ss after -i is slower but yields frame-accurate trims
            cmd = [
                'ffmpeg',
                '-y',
                '-i', clip_path,
                '-ss', str(clip_start),
                '-t', str(segment_duration),
                '-vf', f"fps={TARGET_FPS},scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
                '-c:v', 'libx264',
                '-preset', PRESET,
                '-crf', str(CRF),
                '-g', str(GOP),
                '-keyint_min', str(KEYINT_MIN),
                '-sc_threshold', '0',
                '-an',
                segment_output
            ]

            subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        # verify file exists
        if os.path.exists(segment_output):
            segment_files.append(segment_output)
            concat_list.append(f"file '{os.path.abspath(segment_output)}'")

        if (i + 1) % 5 == 0:
            print(f"   ✅ Created {i+1}/{len(timestamps)-1} segments")

    if not segment_files:
        print("❌ No segments created, aborting.")
        return

    print(f"\n🔗 Concatenating {len(segment_files)} segments (re-encoding to unify streams)...")

    # Create concat file for demuxer
    concat_file = os.path.join(temp_folder, "concat.txt")
    with open(concat_file, 'w') as f:
        f.write('\n'.join(concat_list))

    # Concatenate by demuxer but RE-ENCODE to ensure uniform timestamps/GOPs/codec parameters
    temp_video = os.path.join(temp_folder, "video_no_audio.mp4")
    # Important: we re-encode here (no -c copy) to avoid timestamp/GOP mismatches.
    subprocess.run([
        'ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', concat_file,
        '-c:v', 'libx264',
        '-preset', PRESET,
        '-crf', str(CRF),
        '-pix_fmt', 'yuv420p',
        '-g', str(GOP),
        '-keyint_min', str(KEYINT_MIN),
        '-sc_threshold', '0',
        '-an',
        temp_video
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    print(f"🎵 Adding audio track (final mux)...")
    # Now add audio. Since temp_video is re-encoded and stable, we can copy video stream to save time.
    subprocess.run([
        'ffmpeg', '-y', '-i', temp_video, '-i', audio_path,
        '-c:v', 'copy',  # video already encoded with desired properties
        '-c:a', 'aac', '-b:a', '192k',
        '-shortest',
        output_path
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    print(f"🧹 Cleaning up temporary files...")

    # Cleanup segment files and other temps
    for fpath in segment_files:
        try:
            if os.path.exists(fpath):
                os.remove(fpath)
        except Exception:
            pass

    # Remove other files in temp_folder
    for fname in os.listdir(temp_folder):
        try:
            file_path = os.path.join(temp_folder, fname)
            if os.path.exists(file_path):
                os.remove(file_path)
        except Exception:
            pass

    try:
        if os.path.exists(temp_folder):
            os.rmdir(temp_folder)
    except Exception:
        pass

    # Clean up temp audio if created
    if max_duration and os.path.exists("temp_trimmed_audio.wav"):
        try:
            os.remove("temp_trimmed_audio.wav")
        except Exception:
            pass

    print(f"✅ Video created successfully at: {output_path}\n")
    

def main():
    """Main function that automatically processes the song specified in options.json"""
    # Get script directory for resolving relative paths
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(script_dir)
    
    # Resolve paths relative to script directory
    analysis_json_path = os.path.join(script_dir, ANALYSIS_JSON)
    clips_folder_abs = os.path.join(script_dir, CLIPS_FOLDER)
    audio_folder_abs = os.path.join(script_dir, AUDIO_FOLDER)
    output_folder_abs = os.path.join(script_dir, OUTPUT_FOLDER)
    options_file = os.path.join(project_root, "backend", "uploads", "options.json")
    
    # Load options to find which song to process
    target_song = None
    if os.path.exists(options_file):
        try:
            with open(options_file, 'r') as f:
                options = json.load(f)
                target_song = options.get('song_filename')
                print(f"📋 Loaded options from options.json")
                if target_song:
                    print(f"   Target song: {target_song}\n")
        except Exception as e:
            print(f"⚠️  Error reading options.json: {e}\n")
    
    # Check for analysis file
    if not os.path.exists(analysis_json_path):
        print(f"❌ {ANALYSIS_JSON} not found!")
        print("   Run analyze.py first to analyze audio.\n")
        return
    
    # Load analysis
    with open(analysis_json_path, 'r') as f:
        results = json.load(f)
    
    if not results:
        print("❌ No analysis results found!\n")
        return
    
    # Find the song to process
    songs = list(results.keys())
    
    if target_song:
        # Look for exact match or the most recent analysis of this song
        if target_song in results:
            selected_song = target_song
            print(f"✅ Found analysis for: {target_song}\n")
        else:
            # Check if there's a match without timestamp suffix
            base_name = target_song.rsplit('.', 1)[0]  # Remove extension
            matches = [s for s in songs if s.startswith(base_name)]
            
            if matches:
                # Get most recent analysis (last in list)
                selected_song = matches[-1]
                print(f"✅ Found recent analysis: {selected_song}")
                print(f"   (Requested: {target_song})\n")
            else:
                print(f"❌ No analysis found for: {target_song}")
                print(f"   Available songs: {', '.join(songs)}\n")
                return
    else:
        # No target specified, use first song
        selected_song = songs[0]
        print(f"⚠️  No song specified in options.json")
        print(f"   Using first available: {selected_song}\n")
    
    print(f"🎵 Processing: {selected_song}")
    print(f"⚙️  Using configured MAX_DURATION = {MAX_DURATION}\n")
    
    # Initialize clip manager with absolute path
    clip_manager = ClipManager(clips_folder_abs)
    
    if not clip_manager.clips:
        print(f"❌ No video clips found in '{CLIPS_FOLDER}'!")
        print(f"   Add .mp4, .mov, .avi, or other video files to the folder.\n")
        return
    
    # Create output folder
    if not os.path.exists(output_folder_abs):
        os.makedirs(output_folder_abs)
    
    print("🎥 Creating videos from clips and timestamps")
    print("⚡ ULTRA FAST MODE: Direct ffmpeg processing\n")
    print("="*60)
    
    # Process the selected song
    data = results[selected_song]
    
    # Find the actual audio file (might have different name than analysis key)
    audio_files = [f for f in os.listdir(audio_folder_abs) 
                   if f.lower().endswith(('.mp3', '.wav', '.m4a'))]
    
    # Try to find matching audio file
    audio_path = None
    
    # First try exact match
    if selected_song in audio_files:
        audio_path = os.path.join(audio_folder_abs, selected_song)
    else:
        # Try matching by base name
        base_name = selected_song.rsplit('.', 1)[0]
        for audio_file in audio_files:
            if audio_file.rsplit('.', 1)[0] == base_name or audio_file == base_name:
                audio_path = os.path.join(audio_folder_abs, audio_file)
                break
    
    if not audio_path or not os.path.exists(audio_path):
        print(f"⚠️  Audio file not found for: {selected_song}")
        print(f"   Searched in: {audio_folder_abs}")
        print(f"   Available files: {', '.join(audio_files)}\n")
        return
    
    # SANITIZE OUTPUT FILENAME - THIS IS THE KEY FIX!
    video_filename = selected_song.rsplit('.', 1)[0] + '_final.mp4'
    video_filename = sanitize_filename(video_filename)  # Clean the filename
    output_path = os.path.join(output_folder_abs, video_filename)
    
    print(f"\n🎵 Processing: {selected_song}")
    print(f"   Audio file: {os.path.basename(audio_path)}")
    print(f"   Output file: {video_filename}")
    print(f"   BPM: {data.get('bpm', 0):.1f}")
    print(f"   Analyzed duration: {data.get('duration', 0):.2f}s")
    
    cut_points = data.get('cut_points', [])
    
    if not cut_points:
        print("   ⚠️  No cut points found, skipping...\n")
        return
    
    try:
        create_video_ultrafast(
            audio_path, 
            cut_points, 
            clip_manager, 
            output_path,
            max_duration=MAX_DURATION
        )
        
        # Reset clip usage
        clip_manager.clip_usage = {clip['filename']: [] for clip in clip_manager.clips}
        clip_manager.last_used_clip = None
        
    except Exception as e:
        print(f"❌ Error creating video: {e}\n")
        import traceback
        traceback.print_exc()
    
    print("="*60)
    print(f"✅ Video created in '{OUTPUT_FOLDER}'!")
    print(f"   Final filename: {video_filename}")
    print("="*60 + "\n")

if __name__ == "__main__":
    main()