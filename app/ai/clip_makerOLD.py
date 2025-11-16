# clip_maker.py - ULTRA FAST video generation with ffmpeg direct processing
import json
import os
import random
import subprocess
from pathlib import Path
import librosa
import numpy as np

# -----------------------------
# PATHS
# -----------------------------
SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent  # adjust if your FastAPI root is different

CLIPS_FOLDER = PROJECT_ROOT / "backend/uploads/media"
AUDIO_FOLDER = PROJECT_ROOT / "backend/uploads/songs"
OUTPUT_FOLDER = PROJECT_ROOT / "backend/uploads/final_videos"
ANALYSIS_JSON = SCRIPT_DIR / "audio_analysis.json"

# Ensure output folder exists
OUTPUT_FOLDER.mkdir(parents=True, exist_ok=True)

# Beat types that should trigger clip changes
BEAT_CHANGE_TYPES = {'bass_drop', 'vocal_change', 'downbeat'}


# -----------------------------
# CLIP MANAGER
# -----------------------------
class ClipManager:
    """Manages video clips and tracks used segments to avoid repetition"""

    def __init__(self, clips_folder):
        self.clips_folder = clips_folder
        self.clips = []
        self.clip_usage = {}
        self.last_used_clip = None
        self.load_clips()

    def load_clips(self):
        if not self.clips_folder.exists():
            print(f"❌ '{self.clips_folder}' folder not found!")
            return

        video_files = [f for f in self.clips_folder.iterdir() if f.suffix.lower() in ('.mp4', '.mov', '.avi', '.mkv', '.webm')]

        print(f"📁 Scanning clips from '{self.clips_folder}'...")
        for video_file in video_files:
            try:
                result = subprocess.run(
                    ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                     '-of', 'default=noprint_wrappers=1:nokey=1', str(video_file)],
                    capture_output=True, text=True
                )
                duration = float(result.stdout.strip())
                self.clips.append({
                    'path': video_file,
                    'filename': video_file.name,
                    'duration': duration
                })
                self.clip_usage[video_file.name] = []
                print(f"   ✅ {video_file.name} ({duration:.2f}s)")
            except Exception as e:
                print(f"   ❌ Failed to scan {video_file.name}: {e}")

        print(f"\n📊 Loaded {len(self.clips)} clips\n")

    def get_segment_info(self, duration, force_new_clip=False):
        if not self.clips:
            return None

        if force_new_clip and len(self.clips) > 1:
            available_clips = [c for c in self.clips if c['filename'] != self.last_used_clip]
            clip_data = random.choice(available_clips) if available_clips else random.choice(self.clips)
        else:
            clip_data = random.choice(self.clips)

        clip_duration = clip_data['duration']
        filename = clip_data['filename']
        used_segments = self.clip_usage[filename]

        start_time = 0
        found_unused = False

        if clip_duration >= duration:
            max_start = clip_duration - duration
            for _ in range(10):
                start = random.uniform(0, max_start)
                end = start + duration
                if all(end <= u[0] or start >= u[1] for u in used_segments):
                    start_time = start
                    found_unused = True
                    self.clip_usage[filename].append((start, end))
                    break
            if not found_unused:
                start_time = random.uniform(0, max_start)
                self.clip_usage[filename].append((start_time, start_time + duration))
        else:
            start_time = 0

        self.last_used_clip = filename
        return {
            'path': clip_data['path'],
            'filename': filename,
            'start': start_time,
            'duration': duration,
            'clip_duration': clip_duration
        }


# -----------------------------
# VIDEO CREATION
# -----------------------------
def create_video_ultrafast(audio_path, cut_points, clip_manager, output_path):
    print(f"\n🎬 Creating video ULTRA FAST...")
    print(f"   Audio: {audio_path.name}")
    print(f"   Cut points: {len(cut_points)}")

    y, sr = librosa.load(audio_path, sr=44100, mono=False)
    duration = librosa.get_duration(y=y, sr=sr)

    timestamps = [{'timestamp': 0, 'type': 'start', 'score': 0}] + cut_points + [{'timestamp': duration, 'type': 'end', 'score': 0}]

    temp_folder = PROJECT_ROOT / "temp_segments"
    temp_folder.mkdir(exist_ok=True)

    segment_files = []
    concat_list = []

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

        segment_output = temp_folder / f"segment_{i:04d}.mp4"
        clip_path = segment_info['path']
        clip_start = segment_info['start']
        clip_duration = segment_info['clip_duration']

        try:
            if clip_duration < segment_duration:
                num_loops = int(np.ceil(segment_duration / clip_duration)) + 1
                loop_list = temp_folder / f"loop_{i:04d}.txt"
                with open(loop_list, 'w') as f:
                    for _ in range(num_loops):
                        f.write(f"file '{clip_path.resolve()}'\n")
                subprocess.run([
                    'ffmpeg', '-f', 'concat', '-safe', '0', '-i', str(loop_list),
                    '-t', str(segment_duration),
                    '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-an', '-y', str(segment_output)
                ], check=True)
            else:
                subprocess.run([
                    'ffmpeg', '-ss', str(clip_start), '-i', str(clip_path),
                    '-t', str(segment_duration),
                    '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-an', '-y', str(segment_output)
                ], check=True)
        except subprocess.CalledProcessError as e:
            print(f"❌ ffmpeg failed for segment {i}: {e}")

        segment_files.append(segment_output)
        concat_list.append(f"file '{segment_output.resolve()}'")

        if (i + 1) % 5 == 0:
            print(f"   ✅ Created {i+1}/{len(timestamps)-1} segments")

    # Concatenate segments
    concat_file = temp_folder / "concat.txt"
    concat_file.write_text("\n".join(concat_list))

    temp_video = temp_folder / "video_no_audio.mp4"
    subprocess.run([
        'ffmpeg', '-f', 'concat', '-safe', '0', '-i', str(concat_file),
        '-c', 'copy', '-y', str(temp_video)
    ], check=True)

    # Add audio
    subprocess.run([
        'ffmpeg', '-i', str(temp_video), '-i', str(audio_path),
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-y', str(output_path)
    ], check=True)

    # Cleanup
    for f in temp_folder.iterdir():
        f.unlink()
    temp_folder.rmdir()
    print(f"✅ Video created successfully: {output_path}\n")


# -----------------------------
# TEST INTERACTIVE MODE
# -----------------------------
def test_interactive():
    """Interactive test function that asks for song selection"""
    if not ANALYSIS_JSON.exists():
        print(f"❌ {ANALYSIS_JSON} not found! Run analyze.py first.")
        return

    with open(ANALYSIS_JSON, 'r') as f:
        results = json.load(f)

    if not results:
        print("❌ No analysis results found!")
        return

    songs = list(results.keys())
    print("\n🎵 Available songs:\n")
    for i, song in enumerate(songs, 1):
        data = results[song]
        print(f"  {i}. {song}")
        print(f"     BPM: {data.get('bpm',0):.1f} | Duration: {data.get('duration',0):.2f}s | Cut points: {len(data.get('cut_points',[]))}")

    while True:
        choice = input("\n🎯 Enter song number (or 'all' for all songs, 'q' to quit): ").strip().lower()
        if choice == 'q':
            return
        if choice == 'all':
            selected_songs = songs
            break
        try:
            idx = int(choice) - 1
            if 0 <= idx < len(songs):
                selected_songs = [songs[idx]]
                break
            else:
                print(f"❌ Number out of range 1-{len(songs)}")
        except ValueError:
            print("❌ Invalid input. Enter a number, 'all', or 'q'")

    clip_manager = ClipManager(CLIPS_FOLDER)
    if not clip_manager.clips:
        print(f"❌ No video clips found in {CLIPS_FOLDER}")
        return

    OUTPUT_FOLDER.mkdir(exist_ok=True)

    for filename in selected_songs:
        data = results[filename]
        audio_path = AUDIO_FOLDER / filename
        if not audio_path.exists():
            print(f"⚠️ Audio not found: {audio_path}")
            continue

        video_filename = filename.rsplit('.',1)[0] + '_final.mp4'
        output_path = OUTPUT_FOLDER / video_filename
        cut_points = data.get("cut_points", [])

        if not cut_points:
            print("⚠️ No cut points, skipping")
            continue

        try:
            create_video_ultrafast(audio_path, cut_points, clip_manager, output_path)
            clip_manager.clip_usage = {clip['filename']: [] for clip in clip_manager.clips}
            clip_manager.last_used_clip = None
        except Exception as e:
            print(f"❌ Error creating video: {e}")
            import traceback
            traceback.print_exc()


# -----------------------------
# MAIN AUTOMATIC FUNCTION
# -----------------------------
def main():
    if not ANALYSIS_JSON.exists():
        print(f"❌ {ANALYSIS_JSON} not found! Run analyze.py first.")
        return

    with open(ANALYSIS_JSON, 'r') as f:
        results = json.load(f)

    if not results:
        print("❌ No analysis results found!")
        return

    selected_song = list(results.keys())[0]
    print(f"\n🎵 Automatically processing first song: {selected_song}")

    clip_manager = ClipManager(CLIPS_FOLDER)
    if not clip_manager.clips:
        print(f"❌ No video clips found in {CLIPS_FOLDER}")
        return

    OUTPUT_FOLDER.mkdir(exist_ok=True)

    audio_path = AUDIO_FOLDER / selected_song
    cut_points = results[selected_song].get("cut_points", [])
    video_filename = selected_song.rsplit('.',1)[0] + '_final.mp4'
    output_path = OUTPUT_FOLDER / video_filename

    if not cut_points:
        print("⚠️ No cut points found, skipping")
        return

    create_video_ultrafast(audio_path, cut_points, clip_manager, output_path)


# -----------------------------
# RUN SCRIPT
# -----------------------------
if __name__ == "__main__":
    main()