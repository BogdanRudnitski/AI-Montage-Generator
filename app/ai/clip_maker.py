# clip_maker.py - ULTRA FAST video generation with ffmpeg direct processing
import json
import os
import random
import re
import shutil
import librosa
import soundfile as sf
import subprocess
import numpy as np

from pathlib import Path


def _run_ffmpeg(cmd, step_name="ffmpeg"):
    """Run ffmpeg; on failure print stderr and raise. Prevents silent broken segments."""
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        err = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(f"{step_name} failed (code {result.returncode}): {err[:500]}")

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

# Max time one clip can be held (avoids long "frozen" single-clip segments)
MAX_SEGMENT_DURATION = 4.0
# Min segment duration (avoids ffmpeg/zero-length issues)
MIN_SEGMENT_DURATION = 0.25
# Same frame rate for every segment so concat doesn't stumble (VFR → CFR)
SEGMENT_FPS = 30

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


def _split_long_segments(timestamps, max_seg_duration):
    """Insert fake cut points so no segment is longer than max_seg_duration."""
    out = [timestamps[0]]
    for i in range(1, len(timestamps)):
        start = out[-1]['timestamp']
        end = timestamps[i]['timestamp']
        seg_len = end - start
        while seg_len > max_seg_duration:
            out.append({'timestamp': start + max_seg_duration, 'type': 'split', 'score': 0})
            start = out[-1]['timestamp']
            seg_len = end - start
        out.append(timestamps[i])
    return out


def compute_segments_only(cut_points, duration, clip_manager, max_duration=None):
    """
    Build segment list (which clip, in/out) from cut_points and duration.
    No ffmpeg - used for preview and for saving segments.json before export.
    Returns list of { startTime, endTime, clipFilename, clipStart, clipEnd }.
    """
    cut_points = sorted(cut_points, key=lambda x: x['timestamp'])
    cut_points = [p for p in cut_points if p['timestamp'] < duration]
    timestamps = [{'timestamp': 0, 'type': 'start', 'score': 0}] + cut_points + [{'timestamp': duration, 'type': 'end', 'score': 0}]
    timestamps = _split_long_segments(timestamps, MAX_SEGMENT_DURATION)
    segments = []
    for i in range(len(timestamps) - 1):
        start_time = timestamps[i]['timestamp']
        end_time = timestamps[i + 1]['timestamp']
        segment_duration = end_time - start_time
        if segment_duration < MIN_SEGMENT_DURATION:
            segment_duration = MIN_SEGMENT_DURATION
            end_time = start_time + segment_duration
        current_point = timestamps[i + 1]
        force_new_clip = current_point['type'] in BEAT_CHANGE_TYPES and current_point.get('score', 0) >= 20
        segment_info = clip_manager.get_segment_info(segment_duration, force_new_clip=force_new_clip)
        if not segment_info and clip_manager.clips:
            segment_info = clip_manager.get_segment_info(segment_duration, force_new_clip=False)
        if not segment_info:
            raise RuntimeError("No clips available for segment; cannot continue.")
        clip_duration = segment_info['clip_duration']
        clip_start = segment_info['start']
        if clip_duration < segment_duration:
            clip_end = clip_duration  # full clip; client will loop
        else:
            clip_end = clip_start + segment_duration
        segments.append({
            "startTime": round(start_time, 3),
            "endTime": round(end_time, 3),
            "clipFilename": segment_info['filename'],
            "clipStart": round(clip_start, 3),
            "clipEnd": round(clip_end, 3),
        })
    return segments


def create_video_ultrafast(audio_path, cut_points, clip_manager, output_path, max_duration=None, precomputed_segments=None):
    """Create video using direct ffmpeg concat - NO MoviePy for speed"""
    print(f"\n🎬 Creating video ULTRA FAST...")
    print(f"   Audio: {os.path.basename(audio_path)}")
    print(f"   Cut points: {len(cut_points)}")
    
    # Sort cut points by timestamp
    cut_points = sorted(cut_points, key=lambda x: x['timestamp'])
    
    # Get audio duration
    y, sr = librosa.load(audio_path, sr=44100, mono=False)
    full_duration = librosa.get_duration(y=y, sr=sr)
    
    # Build list of segment specs: either from precomputed_segments or from cut_points + clip_manager
    segment_specs = []
    if precomputed_segments:
        # Resolve clip filename to path via clip_manager
        filename_to_path = {c['filename']: c['path'] for c in clip_manager.clips}
        for seg in precomputed_segments:
            segment_duration = seg['endTime'] - seg['startTime']
            clip_path = filename_to_path.get(seg['clipFilename'])
            if not clip_path:
                raise RuntimeError(f"Precomputed segment references unknown clip: {seg['clipFilename']}")
            clip_start = seg['clipStart']
            clip_end = seg['clipEnd']
            in_clip_duration = clip_end - clip_start
            segment_specs.append({
                'clip_path': clip_path,
                'clip_start': clip_start,
                'segment_duration': segment_duration,
                'clip_duration': in_clip_duration,
            })
        print(f"⚡ Using {len(segment_specs)} precomputed segments...")
        # Duration = end time of last segment (user's edit), capped by audio length
        duration_from_segments = precomputed_segments[-1]['endTime']
        duration = min(duration_from_segments, full_duration)
        print(f"   📐 Duration from segments: {duration_from_segments:.2f}s (capped by audio: {duration:.2f}s)")
        if duration < full_duration:
            max_samples = int(duration * sr)
            if y.ndim == 1:
                y = y[:max_samples]
            else:
                y = y[:, :max_samples]
            temp_audio = "temp_trimmed_audio.wav"
            sf.write(temp_audio, y.T if y.ndim > 1 else y, sr)
            audio_path = temp_audio
            print(f"   ⏱️  Audio trimmed to {duration:.2f}s\n")
        else:
            print(f"   Duration: {duration:.2f}s\n")
    else:
        # Apply max duration limit when not using precomputed segments
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
        cut_points = [p for p in cut_points if p['timestamp'] < duration]
        timestamps = [{'timestamp': 0, 'type': 'start', 'score': 0}] + cut_points + [{'timestamp': duration, 'type': 'end', 'score': 0}]
        timestamps = _split_long_segments(timestamps, MAX_SEGMENT_DURATION)
        print(f"⚡ Generating {len(timestamps)-1} segments (max {MAX_SEGMENT_DURATION}s per clip)...")
        for i in range(len(timestamps) - 1):
            start_time = timestamps[i]['timestamp']
            end_time = timestamps[i + 1]['timestamp']
            segment_duration = end_time - start_time
            if segment_duration < MIN_SEGMENT_DURATION:
                segment_duration = MIN_SEGMENT_DURATION
                end_time = start_time + segment_duration
            current_point = timestamps[i + 1]
            force_new_clip = current_point['type'] in BEAT_CHANGE_TYPES and current_point.get('score', 0) >= 20
            segment_info = clip_manager.get_segment_info(segment_duration, force_new_clip=force_new_clip)
            if not segment_info and clip_manager.clips:
                segment_info = clip_manager.get_segment_info(segment_duration, force_new_clip=False)
            if not segment_info:
                raise RuntimeError("No clips available for segment; cannot continue.")
            clip_duration = segment_info['clip_duration']
            if clip_duration < segment_duration:
                in_clip_duration = clip_duration
            else:
                in_clip_duration = segment_duration
            segment_specs.append({
                'clip_path': segment_info['path'],
                'clip_start': segment_info['start'],
                'segment_duration': segment_duration,
                'clip_duration': clip_duration,
            })
    
    # Wipe temp folder so we never reuse broken/leftover segment files
    temp_folder = "temp_segments"
    if os.path.exists(temp_folder):
        shutil.rmtree(temp_folder)
    os.makedirs(temp_folder, exist_ok=True)
    
    segment_files = []
    concat_list = []
    
    for i, spec in enumerate(segment_specs):
        segment_output = os.path.join(temp_folder, f"segment_{i:04d}.mp4")
        clip_path = spec['clip_path']
        clip_start = spec['clip_start']
        segment_duration = spec['segment_duration']
        clip_duration = spec['clip_duration']
        
        if clip_duration < segment_duration:
            # Loop short clip and trim to exact duration
            num_loops = int(np.ceil(segment_duration / clip_duration)) + 1
            loop_list = os.path.join(temp_folder, f"loop_{i:04d}.txt")
            # Escape path for concat demuxer (single quotes)
            abs_path = os.path.abspath(clip_path)
            safe_path = abs_path.replace("'", "'\\''")
            with open(loop_list, 'w') as f:
                for _ in range(num_loops):
                    f.write(f"file '{safe_path}'\n")
            # Same FPS + keyframe at start so concat doesn't freeze at boundaries
            _run_ffmpeg([
                'ffmpeg', '-f', 'concat', '-safe', '0', '-i', loop_list,
                '-t', str(segment_duration),
                '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
                '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
                '-r', str(SEGMENT_FPS), '-vsync', 'cfr',
                '-force_key_frames', 'expr:gte(t,0)',
                '-an', '-y', segment_output
            ], step_name=f"segment_{i} (loop)")
        else:
            # -i then -ss = accurate seek. Same FPS + keyframe at start for clean concat.
            _run_ffmpeg([
                'ffmpeg', '-i', clip_path, '-ss', str(clip_start),
                '-t', str(segment_duration),
                '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
                '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
                '-r', str(SEGMENT_FPS), '-vsync', 'cfr',
                '-force_key_frames', 'expr:gte(t,0)',
                '-an', '-y', segment_output
            ], step_name=f"segment_{i} (extract)")
        
        # Ensure segment was written and has content (catches silent ffmpeg failures)
        if not os.path.exists(segment_output) or os.path.getsize(segment_output) < 1000:
            raise RuntimeError(f"Segment {i} produced invalid file: {segment_output}")
        
        abs_seg = os.path.abspath(segment_output)
        safe_seg = abs_seg.replace("'", "'\\''")
        concat_list.append(f"file '{safe_seg}'")
        segment_files.append(segment_output)
        
        if (i + 1) % 5 == 0:
            print(f"   ✅ Created {i+1}/{len(segment_specs)} segments")
    
    print(f"\n🔗 Concatenating {len(segment_files)} segments...")
    
    concat_file = os.path.join(temp_folder, "concat.txt")
    with open(concat_file, 'w') as f:
        f.write('\n'.join(concat_list))
    
    temp_video = os.path.join(temp_folder, "video_no_audio.mp4")
    _run_ffmpeg([
        'ffmpeg', '-f', 'concat', '-safe', '0', '-i', concat_file,
        '-c', 'copy', '-y', temp_video
    ], step_name="concat segments")
    
    # Re-encode trim to one continuous stream (avoids concat-boundary freezes from -c copy)
    temp_video_trimmed = os.path.join(temp_folder, "video_trimmed.mp4")
    _run_ffmpeg([
        'ffmpeg', '-i', temp_video, '-t', str(duration),
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
        '-r', str(SEGMENT_FPS), '-vsync', 'cfr',
        '-an', '-y', temp_video_trimmed
    ], step_name="trim and re-encode")
    
    print(f"🎵 Adding audio track ({duration:.1f}s)...")
    
    _run_ffmpeg([
        'ffmpeg', '-i', temp_video_trimmed, '-i', audio_path,
        '-t', str(duration),
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-y', output_path
    ], step_name="mux audio")
    
    print(f"🧹 Cleaning up temporary files...")
    
    # Cleanup temp files
    for f in segment_files:
        if os.path.exists(f):
            os.remove(f)
    
    for f in os.listdir(temp_folder):
        file_path = os.path.join(temp_folder, f)
        try:
            if os.path.isfile(file_path):
                os.remove(file_path)
        except OSError:
            pass
    
    if os.path.exists(temp_folder):
        os.rmdir(temp_folder)
    
    # Clean up temp audio if we created one
    if max_duration and os.path.exists("temp_trimmed_audio.wav"):
        os.remove("temp_trimmed_audio.wav")
    
    print(f"✅ Video created successfully!\n")

def main():
    """Main function that automatically processes the song specified in options.json"""
    # Get script directory and project root for resolving paths
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(script_dir)
    
    # Paths: analysis in ai/, media/output in backend/uploads/
    analysis_json_path = os.path.join(script_dir, os.path.basename(ANALYSIS_JSON))
    clips_folder_abs = os.path.join(project_root, "backend", "uploads", "media")
    audio_folder_abs = os.path.join(project_root, "backend", "uploads", "songs")
    output_folder_abs = os.path.join(project_root, "backend", "uploads", "final_videos")
    options_file = os.path.join(project_root, "backend", "uploads", "options.json")
    segments_path = os.path.join(os.path.dirname(output_folder_abs), "segments.json")
    
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
    
    # Export-only path: segments.json was written by POST /export; use it without requiring audio_analysis.json
    precomputed_segments = None
    if os.path.exists(segments_path) and target_song:
        try:
            with open(segments_path, 'r') as f:
                precomputed_segments = json.load(f)
        except Exception as e:
            print(f"⚠️  Could not load segments.json: {e}")
    if precomputed_segments and target_song:
        print(f"📤 Export-only mode: using {len(precomputed_segments)} segments from segments.json (no analysis required)\n")
        clip_manager = ClipManager(clips_folder_abs)
        if not clip_manager.clips:
            print(f"❌ No video clips found in '{CLIPS_FOLDER}'!\n")
            return
        if not os.path.exists(output_folder_abs):
            os.makedirs(output_folder_abs)
        # Find audio file (match by name with or without extension)
        audio_files = [f for f in os.listdir(audio_folder_abs)
                       if f.lower().endswith(('.mp3', '.wav', '.m4a')) or ('.' not in f and not f.startswith('.'))]
        base_target = target_song.rsplit('.', 1)[0]
        audio_path = None
        for f in audio_files:
            if f == target_song or f.rsplit('.', 1)[0] == base_target or f == base_target:
                audio_path = os.path.join(audio_folder_abs, f)
                break
        if not audio_path or not os.path.exists(audio_path):
            print(f"⚠️  Audio file not found for: {target_song}")
            print(f"   Searched in: {audio_folder_abs}\n")
            return
        video_filename = base_target + '_final.mp4'
        video_filename = sanitize_filename(video_filename)
        output_path = os.path.join(output_folder_abs, video_filename)
        print(f"🎵 Export: {target_song} -> {video_filename}\n")
        try:
            create_video_ultrafast(
                audio_path, [], clip_manager, output_path,
                max_duration=MAX_DURATION,
                precomputed_segments=precomputed_segments
            )
            print("="*60)
            print(f"✅ Video created in '{OUTPUT_FOLDER}'!")
            print(f"   Final filename: {video_filename}")
            print("="*60 + "\n")
        except Exception as e:
            print(f"❌ Error creating video: {e}\n")
            import traceback
            traceback.print_exc()
        return
    
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
    
    # Load precomputed segments from POST /export (segments.json) first; export path does not need cut_points
    segments_path = os.path.join(os.path.dirname(output_folder_abs), "segments.json")
    precomputed_segments = None
    if os.path.exists(segments_path):
        try:
            with open(segments_path, 'r') as f:
                precomputed_segments = json.load(f)
            if precomputed_segments:
                print(f"   Using {len(precomputed_segments)} precomputed segments from segments.json")
        except Exception as e:
            print(f"   ⚠️  Could not load segments.json: {e}")
    
    if not cut_points and not precomputed_segments:
        print("   ⚠️  No cut points and no precomputed segments, skipping...\n")
        return
    
    try:
        create_video_ultrafast(
            audio_path, 
            cut_points, 
            clip_manager, 
            output_path,
            max_duration=MAX_DURATION,
            precomputed_segments=precomputed_segments
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