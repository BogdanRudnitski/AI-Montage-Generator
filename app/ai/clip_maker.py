# clip_maker.py - ULTRA FAST video generation with ffmpeg direct processing
import json
import os
import random
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

# Beat types that should trigger clip changes
BEAT_CHANGE_TYPES = {'bass_drop', 'vocal_change', 'downbeat'}

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
        
        print(f"📁 Scanning clips from '{self.clips_folder}'...")
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

def create_video_ultrafast(audio_path, cut_points, clip_manager, output_path):
    """Create video using direct ffmpeg concat - NO MoviePy for speed"""
    print(f"\n🎬 Creating video ULTRA FAST...")
    print(f"   Audio: {os.path.basename(audio_path)}")
    print(f"   Cut points: {len(cut_points)}")
    
    # Sort cut points by timestamp
    cut_points = sorted(cut_points, key=lambda x: x['timestamp'])
    
    # Get audio duration
    y, sr = librosa.load(audio_path, sr=44100, mono=False)
    duration = librosa.get_duration(y=y, sr=sr)
    
    # Create segments between timestamps
    timestamps = [{'timestamp': 0, 'type': 'start', 'score': 0}] + cut_points + [{'timestamp': duration, 'type': 'end', 'score': 0}]
    
    print(f"\n⚡ Generating {len(timestamps)-1} segments...")
    
    # Create temp folder for segments
    temp_folder = "temp_segments"
    os.makedirs(temp_folder, exist_ok=True)
    
    segment_files = []
    concat_list = []
    
    for i in range(len(timestamps) - 1):
        start_time = timestamps[i]['timestamp']
        end_time = timestamps[i + 1]['timestamp']
        segment_duration = end_time - start_time
        
        # Check if this is a major beat
        current_point = timestamps[i + 1]
        force_new_clip = current_point['type'] in BEAT_CHANGE_TYPES and current_point.get('score', 0) >= 20
        
        if force_new_clip:
            print(f"   🎵 Beat drop at {current_point['timestamp']:.2f}s - forcing new clip!")
        
        # Get segment info (no actual loading)
        segment_info = clip_manager.get_segment_info(segment_duration, force_new_clip=force_new_clip)
        
        if not segment_info:
            continue
        
        # Create segment using ffmpeg directly (FAST!)
        segment_output = os.path.join(temp_folder, f"segment_{i:04d}.mp4")
        
        clip_path = segment_info['path']
        clip_start = segment_info['start']
        clip_duration = segment_info['clip_duration']
        
        # If clip is shorter than needed, loop it
        if clip_duration < segment_duration:
            # Calculate how many loops needed
            num_loops = int(np.ceil(segment_duration / clip_duration)) + 1
            
            # Create concat demuxer file for looping
            loop_list = os.path.join(temp_folder, f"loop_{i:04d}.txt")
            with open(loop_list, 'w') as f:
                for _ in range(num_loops):
                    f.write(f"file '{os.path.abspath(clip_path)}'\n")
            
            # Concat and trim to exact duration
            subprocess.run([
                'ffmpeg', '-f', 'concat', '-safe', '0', '-i', loop_list,
                '-t', str(segment_duration),
                '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
                '-an',  # No audio in segments
                '-y', segment_output
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            # Extract segment from clip directly
            subprocess.run([
                'ffmpeg', '-ss', str(clip_start), '-i', clip_path,
                '-t', str(segment_duration),
                '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
                '-an',  # No audio in segments
                '-y', segment_output
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        
        segment_files.append(segment_output)
        concat_list.append(f"file '{os.path.abspath(segment_output)}'")
        
        if (i + 1) % 5 == 0:
            print(f"   ✅ Created {i+1}/{len(timestamps)-1} segments")
    
    print(f"\n🔗 Concatenating {len(segment_files)} segments...")
    
    # Create concat file
    concat_file = os.path.join(temp_folder, "concat.txt")
    with open(concat_file, 'w') as f:
        f.write('\n'.join(concat_list))
    
    # Concatenate all segments
    temp_video = os.path.join(temp_folder, "video_no_audio.mp4")
    subprocess.run([
        'ffmpeg', '-f', 'concat', '-safe', '0', '-i', concat_file,
        '-c', 'copy',  # Copy without re-encoding (SUPER FAST)
        '-y', temp_video
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    
    print(f"🎵 Adding audio track...")
    
    # Add audio to final video
    subprocess.run([
        'ffmpeg', '-i', temp_video, '-i', audio_path,
        '-c:v', 'copy',  # Copy video (no re-encoding)
        '-c:a', 'aac', '-b:a', '192k',
        '-shortest',  # Match shortest stream
        '-y', output_path
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    
    print(f"🧹 Cleaning up temporary files...")
    
    # Cleanup temp files
    for f in segment_files:
        if os.path.exists(f):
            os.remove(f)
    
    # Clean up other temp files
    for f in os.listdir(temp_folder):
        file_path = os.path.join(temp_folder, f)
        if os.path.exists(file_path):
            os.remove(file_path)
    
    if os.path.exists(temp_folder):
        os.rmdir(temp_folder)
    
    print(f"✅ Video created successfully!\n")

def test_interactive():
    """Interactive test function that asks for song selection"""
    # Get script directory for resolving relative paths
    script_dir = os.path.dirname(os.path.abspath(__file__))
    
    # Resolve paths relative to script directory
    analysis_json_path = os.path.join(script_dir, ANALYSIS_JSON)
    clips_folder_abs = os.path.join(script_dir, CLIPS_FOLDER)
    audio_folder_abs = os.path.join(script_dir, AUDIO_FOLDER)
    output_folder_abs = os.path.join(script_dir, OUTPUT_FOLDER)
    
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
    
    # Show available songs
    print("🎵 Available songs:\n")
    songs = list(results.keys())
    for i, song in enumerate(songs, 1):
        data = results[song]
        print(f"  {i}. {song}")
        print(f"     BPM: {data.get('bpm', 0):.1f} | Duration: {data.get('duration', 0):.2f}s | Cut points: {len(data.get('cut_points', []))}")
    
    print("\n" + "="*60)
    
    # Get user choice
    while True:
        choice = input("\n🎯 Enter song number (or 'all' for all songs, 'q' to quit): ").strip().lower()
        
        if choice == 'q':
            print("👋 Exiting...\n")
            return
        
        if choice == 'all':
            selected_songs = songs
            break
        
        try:
            song_idx = int(choice) - 1
            if 0 <= song_idx < len(songs):
                selected_songs = [songs[song_idx]]
                break
            else:
                print(f"❌ Please enter a number between 1 and {len(songs)}")
        except ValueError:
            print("❌ Please enter a valid number, 'all', or 'q'")
    
    print("\n" + "="*60)
    
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
    
    # Process selected songs
    for filename in selected_songs:
        data = results[filename]
        audio_path = os.path.join(audio_folder_abs, filename)
        
        if not os.path.exists(audio_path):
            print(f"⚠️  Audio file not found: {audio_path}")
            continue
        
        # Output filename
        video_filename = filename.rsplit('.', 1)[0] + '_final.mp4'
        output_path = os.path.join(output_folder_abs, video_filename)
        
        print(f"\n🎵 Processing: {filename}")
        print(f"   BPM: {data.get('bpm', 0):.1f}")
        print(f"   Duration: {data.get('duration', 0):.2f}s")
        
        cut_points = data.get('cut_points', [])
        
        if not cut_points:
            print("   ⚠️  No cut points found, skipping...\n")
            continue
        
        try:
            create_video_ultrafast(audio_path, cut_points, clip_manager, output_path)
            
            # Reset clip usage for next video
            clip_manager.clip_usage = {clip['filename']: [] for clip in clip_manager.clips}
            clip_manager.last_used_clip = None
            
        except Exception as e:
            print(f"❌ Error creating video: {e}\n")
            import traceback
            traceback.print_exc()
    
    print("="*60)
    print(f"✅ All videos created in '{OUTPUT_FOLDER}'!")
    print("="*60 + "\n")

def main():
    """Main function that automatically processes the first song from analysis results"""
    # Get script directory for resolving relative paths
    script_dir = os.path.dirname(os.path.abspath(__file__))
    
    # Resolve paths relative to script directory
    analysis_json_path = os.path.join(script_dir, ANALYSIS_JSON)
    clips_folder_abs = os.path.join(script_dir, CLIPS_FOLDER)
    audio_folder_abs = os.path.join(script_dir, AUDIO_FOLDER)
    output_folder_abs = os.path.join(script_dir, OUTPUT_FOLDER)
    
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
    
    # Get first song automatically
    songs = list(results.keys())
    if not songs:
        print("❌ No songs found in analysis results!\n")
        return
    
    selected_songs = [songs[0]]  # Use first song
    first_song = songs[0]
    
    print(f"🎵 Automatically processing first song: {first_song}")
    
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
    
    # Process selected songs
    for filename in selected_songs:
        data = results[filename]
        audio_path = os.path.join(audio_folder_abs, filename)
        
        if not os.path.exists(audio_path):
            print(f"⚠️  Audio file not found: {audio_path}")
            continue
        
        # Output filename
        video_filename = filename.rsplit('.', 1)[0] + '_final.mp4'
        output_path = os.path.join(output_folder_abs, video_filename)
        
        print(f"\n🎵 Processing: {filename}")
        print(f"   BPM: {data.get('bpm', 0):.1f}")
        print(f"   Duration: {data.get('duration', 0):.2f}s")
        
        cut_points = data.get('cut_points', [])
        
        if not cut_points:
            print("   ⚠️  No cut points found, skipping...\n")
            continue
        
        try:
            create_video_ultrafast(audio_path, cut_points, clip_manager, output_path)
            
            # Reset clip usage for next video
            clip_manager.clip_usage = {clip['filename']: [] for clip in clip_manager.clips}
            clip_manager.last_used_clip = None
            
        except Exception as e:
            print(f"❌ Error creating video: {e}\n")
            import traceback
            traceback.print_exc()
    
    print("="*60)
    print(f"✅ All videos created in '{OUTPUT_FOLDER}'!")
    print("="*60 + "\n")

if __name__ == "__main__":
    main()