# visualizer.py - SIMPLE FLASHES ONLY
import json
import numpy as np
from moviepy import AudioFileClip, ColorClip, CompositeVideoClip
from moviepy.video.fx.FadeIn import FadeIn as fadein
from moviepy.video.fx.FadeOut import FadeOut as fadeout
import os
import librosa
import soundfile as sf

AUDIO_FOLDER = "audio"
OUTPUT_FOLDER = "visualizations"
ANALYSIS_JSON = "audio_analysis.json"

def create_visualization(audio_path, cut_points, output_path):
    print(f"\n🎬 Creating visualization...")
    y, sr = librosa.load(audio_path, sr=44100, mono=False)
    duration = librosa.get_duration(y=y, sr=sr)
    temp_wav = "temp_audio.wav"
    if y.ndim == 1:
        sf.write(temp_wav, y, sr)
    else:
        sf.write(temp_wav, y.T, sr)
    audio = AudioFileClip(temp_wav)
    print(f"   Duration: {duration:.2f}s")
    print(f"   Cut points: {len(cut_points)}\n")
    
    base = ColorClip(size=(1280, 720), color=(0, 0, 0), duration=duration)
    clips = [base]
    
    for point in cut_points:
        timestamp = point['timestamp']
        if timestamp >= duration - 0.2:
            continue
        colors = {'bass_drop': (255, 0, 0), 'vocal_change': (0, 255, 255), 'downbeat': (255, 255, 0), 'strong_hit': (255, 128, 0)}
        color = colors.get(point['type'], (255, 255, 255))
        intensity = min(1.0, point['score'] / 25.0)
        flash_color = tuple(int(c * intensity) for c in color)
        
        flash = ColorClip(size=(1280, 720), color=flash_color, duration=0.15).with_start(timestamp).with_opacity(0.7)
        flash = flash.with_effects([fadein(0.05), fadeout(0.05)])
        clips.append(flash)
    
    print("   Compositing...")
    video = CompositeVideoClip(clips, size=(1280, 720))
    
    print(f"   Video duration: {video.duration:.2f}s")
    print(f"   Setting audio...")
    video = video.with_audio(audio)
    print(f"   Video has audio: {video.audio is not None}")
    
    print(f"   Writing to: {output_path}\n")
    video.write_videofile(
        output_path, 
        fps=30, 
        codec='libx264', 
        audio_codec='aac', 
        preset='medium', 
        threads=4
    )
    
    print(f"\n   Checking output file audio...")
    import subprocess
    result = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'default=nw=1', output_path], capture_output=True, text=True)
    print(f"   FFprobe output: {result.stdout}")
    if os.path.exists(temp_wav):
        os.remove(temp_wav)
    print(f"   ✅ Done!\n")

def main():
    if not os.path.exists(ANALYSIS_JSON):
        print(f"❌ {ANALYSIS_JSON} not found!\n")
        return
    with open(ANALYSIS_JSON, 'r') as f:
        results = json.load(f)
    if not results:
        print("❌ No results!\n")
        return
    if not os.path.exists(OUTPUT_FOLDER):
        os.makedirs(OUTPUT_FOLDER)
    print("🎨 Creating visualizations\n")
    for filename, data in results.items():
        audio_path = os.path.join(AUDIO_FOLDER, filename)
        if not os.path.exists(audio_path):
            continue
        video_filename = filename.rsplit('.', 1)[0] + '_visualization.mp4'
        output_path = os.path.join(OUTPUT_FOLDER, video_filename)
        print(f"🎵 {filename}")
        cut_points = data.get('cut_points', [])
        if not cut_points:
            continue
        try:
            create_visualization(audio_path, cut_points, output_path)
        except Exception as e:
            print(f"   ❌ Error: {e}\n")
            import traceback
            traceback.print_exc()
    print(f"✅ Complete!\n")

if __name__ == "__main__":
    main()