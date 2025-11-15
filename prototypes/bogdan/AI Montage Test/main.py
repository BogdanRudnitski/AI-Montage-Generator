# audio_analyzer_pure_ai.py - 100% AI-based rhythm detection with song selection
import os
import json
import torch
import numpy as np
from demucs import pretrained
from demucs.apply import apply_model
import librosa

AUDIO_FOLDER = "audio"
OUTPUT_JSON = "audio_analysis.json"

def analyze_with_pure_ai(audio_path):
    """
    Use Demucs AI to separate stems, then analyze rhythm from isolated drums
    This is 100% neural network based
    """
    print(f"\n{'='*60}")
    print(f"🎵 Analyzing: {os.path.basename(audio_path)}")
    print(f"{'='*60}\n")
    
    # 1. LOAD DEMUCS AI MODEL
    print("🤖 Loading Demucs AI model (Transformer neural network)...")
    print("   (First run will download ~300MB model)\n")
    
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = pretrained.get_model('htdemucs')
    model.to(device)
    model.eval()
    
    print(f"   Model loaded on: {device}\n")
    
    # 2. LOAD AUDIO
    print("📂 Loading audio...")
    import librosa
    
    # Load with librosa
    wav_np, sr = librosa.load(audio_path, sr=44100, mono=False)
    
    # Convert to torch tensor and ensure stereo
    if wav_np.ndim == 1:
        wav_np = np.stack([wav_np, wav_np])
    elif wav_np.shape[0] == 1:
        wav_np = np.vstack([wav_np, wav_np])
    
    wav = torch.from_numpy(wav_np).float()
    sr = 44100
    
    duration = wav.shape[1] / sr
    print(f"   Duration: {duration:.2f}s | Sample rate: {sr}Hz\n")
    
    # 3. AI SOURCE SEPARATION
    print("🎛️  Running AI source separation...")
    print("   Separating: drums, bass, vocals, other\n")
    
    with torch.no_grad():
        wav_tensor = wav.unsqueeze(0).to(device)
        sources = apply_model(model, wav_tensor, device=device)[0]
    
    # Sources: [drums, bass, other, vocals]
    drums = sources[0].cpu().numpy()
    bass = sources[1].cpu().numpy()
    vocals = sources[3].cpu().numpy()
    
    print("   ✅ AI separation complete!\n")
    
    # 4. ANALYZE DRUMS FOR RHYTHM (AI-isolated drum track)
    print("🥁 Analyzing AI-isolated drum track for rhythm...")
    
    # Get drum energy over time
    drum_mono = np.mean(drums, axis=0)
    
    # Frame-based energy analysis with smaller hop for precision
    frame_length = 2048
    hop_length = 256  # Smaller hop = more precise (was 512)
    
    drum_energy = []
    for i in range(0, len(drum_mono) - frame_length, hop_length):
        frame = drum_mono[i:i + frame_length]
        energy = np.sqrt(np.mean(frame**2))
        drum_energy.append(energy)
    
    drum_energy = np.array(drum_energy)
    times = np.arange(len(drum_energy)) * hop_length / sr
    
    # Find peaks in drum energy (these are drum hits)
    from scipy.signal import find_peaks
    
    # Normalize
    if np.max(drum_energy) > 0:
        drum_energy_norm = drum_energy / np.max(drum_energy)
    else:
        drum_energy_norm = drum_energy
    
    # Find significant drum hits with SUPER SENSITIVE parameters
    peak_indices, properties = find_peaks(
        drum_energy_norm,
        height=0.08,  # VERY low threshold - catch almost everything
        distance=int(0.05 * sr / hop_length),  # 50ms apart - very tight
        prominence=0.02  # Minimal prominence requirement
    )
    
    drum_hit_times = times[peak_indices]
    drum_hit_strengths = properties['peak_heights']
    
    print(f"   Found {len(drum_hit_times)} AI-detected drum hits\n")
    
    # 5. ESTIMATE TEMPO FROM AI-DETECTED DRUM HITS
    print("🎼 Estimating tempo from AI drum analysis...")
    
    if len(drum_hit_times) > 1:
        intervals = np.diff(drum_hit_times)
        
        # Remove outliers
        valid_intervals = intervals[(intervals > 0.15) & (intervals < 2.0)]
        
        if len(valid_intervals) > 0:
            median_interval = np.median(valid_intervals)
            bpm = 60.0 / median_interval
        else:
            bpm = 0
    else:
        bpm = 0
    
    print(f"   AI-detected BPM: {bpm:.1f}\n")
    
    # 6. DETECT RHYTHM PATTERNS AND STRUCTURAL CHANGES
    print("🎯 Detecting rhythm patterns and musical structure...")
    
    # Group drum hits into bars (assuming 4/4 time)
    beat_interval = 60.0 / bpm if bpm > 0 else 0.5
    bar_length = beat_interval * 4
    
    rhythm_points = []
    
    # DETECT EVERY SINGLE BEAT - Not just downbeats
    if bpm > 0:
        beat_duration = 60.0 / bpm
        num_beats = int(duration / beat_duration)
        
        print(f"   Detecting {num_beats} individual beats...")
        
        for beat_idx in range(num_beats):
            beat_time = beat_idx * beat_duration
            
            # Find closest drum hit to this theoretical beat
            if len(drum_hit_times) > 0:
                closest_idx = np.argmin(np.abs(drum_hit_times - beat_time))
                closest_hit_time = drum_hit_times[closest_idx]
                closest_hit_strength = drum_hit_strengths[closest_idx]
                
                # Only use if it's within 100ms of theoretical beat
                if abs(closest_hit_time - beat_time) < 0.1:
                    # Every 4th beat is a downbeat (stronger)
                    is_downbeat = beat_idx % 4 == 0
                    
                    rhythm_points.append({
                        'timestamp': float(closest_hit_time),
                        'type': 'downbeat' if is_downbeat else 'beat',
                        'strength': float(closest_hit_strength),
                        'description': 'Strong downbeat' if is_downbeat else 'Beat',
                        'score': 22 if is_downbeat else 18
                    })
    
    # Detect rhythmic density changes (verse vs chorus transitions)
    print("   Analyzing rhythmic density changes...")
    window_size = int(1.5 * sr / hop_length)  # 1.5 second window
    density_changes = []
    
    for i in range(window_size, len(drum_energy) - window_size, window_size // 4):
        before_window = drum_energy[i - window_size:i]
        after_window = drum_energy[i:i + window_size]
        
        # Count peaks in each window (rhythm density)
        before_peaks = len(find_peaks(before_window, height=0.15)[0])
        after_peaks = len(find_peaks(after_window, height=0.15)[0])
        
        # Significant change in rhythm density
        if abs(after_peaks - before_peaks) > 3:  # Lower threshold
            change_time = times[i]
            
            if not density_changes or (change_time - density_changes[-1]['timestamp'] > 2.0):
                density_changes.append({
                    'timestamp': float(change_time),
                    'type': 'rhythm_change',
                    'description': f'Rhythm density change',
                    'score': 24
                })
    
    print(f"   Found {len(rhythm_points)} beats and {len(density_changes)} rhythm changes\n")
    
    # 7. ANALYZE BASS FOR DROPS - SUPER AGGRESSIVE
    print("🎢 Analyzing AI-isolated bass for drops...")
    
    bass_mono = np.mean(bass, axis=0)
    
    bass_energy = []
    for i in range(0, len(bass_mono) - frame_length, hop_length):
        frame = bass_mono[i:i + frame_length]
        energy = np.sqrt(np.mean(frame**2))
        bass_energy.append(energy)
    
    bass_energy = np.array(bass_energy)
    
    # Find bass drops (sudden increases) - VERY SENSITIVE
    drops = []
    window = int(0.5 * sr / hop_length)  # Even shorter 0.5 second window
    
    for i in range(window, len(bass_energy) - window, window // 4):  # Check every 0.125s
        before = np.mean(bass_energy[i - window:i])
        after = np.mean(bass_energy[i:i + window])
        
        # VERY low threshold for bass drops
        if after > before * 1.3 and before > 0.0001:  # Just 1.3x increase!
            drop_time = times[i]
            
            # Avoid duplicates but very short window
            if not drops or (drop_time - drops[-1]['timestamp'] > 1.0):
                drops.append({
                    'timestamp': float(drop_time),
                    'type': 'bass_drop',
                    'intensity': float(after / before),
                    'description': 'Bass increase',
                    'score': 26
                })
    
    # ALSO detect ALL significant bass peaks
    print("   Analyzing bass peaks...")
    if np.max(bass_energy) > 0:
        bass_norm = bass_energy / np.max(bass_energy)
        bass_peaks, bass_props = find_peaks(
            bass_norm,
            height=0.3,  # Lower threshold - catch more
            distance=int(0.8 * sr / hop_length),  # 0.8s apart
            prominence=0.1  # Lower prominence
        )
        
        for peak_idx in bass_peaks:
            peak_time = times[peak_idx]
            
            # Make sure it's not a duplicate of existing drops
            is_duplicate = any(abs(peak_time - d['timestamp']) < 1.0 for d in drops)
            
            if not is_duplicate:
                drops.append({
                    'timestamp': float(peak_time),
                    'type': 'bass_drop',
                    'intensity': float(bass_norm[peak_idx]),
                    'description': 'Bass peak',
                    'score': 25
                })
    
    print(f"   Found {len(drops)} bass drops/peaks\n")
    
    # 8. ANALYZE VOCAL SECTIONS - SUPER DETAILED
    print("🎤 Analyzing AI-isolated vocals for structure...")
    
    vocal_mono = np.mean(vocals, axis=0)
    
    vocal_energy = []
    for i in range(0, len(vocal_mono) - frame_length, hop_length):
        frame = vocal_mono[i:i + frame_length]
        energy = np.sqrt(np.mean(frame**2))
        vocal_energy.append(energy)
    
    vocal_energy = np.array(vocal_energy)
    
    # Find vocal section changes (verse/chorus transitions) - VERY SENSITIVE
    vocal_changes = []
    
    for i in range(1, len(vocal_energy) - 1):
        # Compare vocal energy before and after
        window = int(1.5 * sr / hop_length)  # 1.5 second window
        
        if i > window and i < len(vocal_energy) - window:
            before = np.mean(vocal_energy[i - window:i])
            after = np.mean(vocal_energy[i:i + window])
            
            # Very low threshold for changes
            if (after > before * 1.2 or before > after * 1.2) and min(before, after) > 0.001:
                change_time = times[i]
                
                if not vocal_changes or (change_time - vocal_changes[-1]['timestamp'] > 2.0):
                    vocal_changes.append({
                        'timestamp': float(change_time),
                        'type': 'vocal_change',
                        'description': 'Vocal section change',
                        'score': 23
                    })
    
    # Detect vocal rhythm/cadence changes (alliteration, flow changes) - SUPER SENSITIVE
    print("   Analyzing vocal rhythm and cadence...")
    
    # Use spectral flux on vocals to detect rapid changes
    vocal_flux = []
    for i in range(1, len(vocal_energy)):
        flux = abs(vocal_energy[i] - vocal_energy[i-1])
        vocal_flux.append(flux)
    
    vocal_flux = np.array(vocal_flux)
    
    # High flux = rapid vocal changes (alliteration, stutters, fast delivery)
    window = int(0.3 * sr / hop_length)  # Even shorter 0.3 second window
    for i in range(window, len(vocal_flux) - window, window // 3):
        local_flux = vocal_flux[i - window:i + window]
        flux_intensity = np.mean(local_flux)
        
        # Lower threshold - catch more
        if flux_intensity > np.percentile(vocal_flux, 70):  # Top 30%
            flux_time = times[i]
            
            # Check if not duplicate
            is_duplicate = any(abs(flux_time - vc['timestamp']) < 1.5 for vc in vocal_changes)
            
            if not is_duplicate:
                vocal_changes.append({
                    'timestamp': float(flux_time),
                    'type': 'vocal_rhythm',
                    'description': 'Vocal rhythm change',
                    'score': 21
                })
    
    print(f"   Found {len(vocal_changes)} vocal structure changes\n")
    
    # 9. COMBINE ALL AI DETECTIONS - MORE COMPREHENSIVE
    print("✨ Combining all AI detections...\n")
    
    all_points = []
    all_points.extend(drops)
    all_points.extend(vocal_changes)
    all_points.extend(rhythm_points)
    all_points.extend(density_changes)
    
    # Add top 50% strongest drum hits (was 60%)
    strong_threshold = np.percentile(drum_hit_strengths, 50)
    for t, s in zip(drum_hit_times, drum_hit_strengths):
        if s >= strong_threshold:
            all_points.append({
                'timestamp': float(t),
                'type': 'strong_hit',
                'strength': float(s),
                'description': 'Strong drum hit',
                'score': 15
            })
    
    # Remove duplicates with even tighter window
    all_points.sort(key=lambda x: x['timestamp'])
    filtered = []
    
    for point in all_points:
        if not filtered or (point['timestamp'] - filtered[-1]['timestamp'] > 0.2):  # 0.2s
            filtered.append(point)
        elif point['score'] > filtered[-1]['score']:
            # If this point has higher score, replace the last one
            filtered[-1] = point
    
    # Sort by score AND timestamp
    filtered.sort(key=lambda x: (-x['score'], x['timestamp']))
    
    print(f"✅ Generated {len(filtered)} AI-detected cut points\n")
    
    return {
        'duration': float(duration),
        'bpm': float(bpm),
        'ai_model': 'Demucs HTDemucs (Transformer)',
        'total_drum_hits': int(len(drum_hit_times)),
        'cut_points': filtered[:40],  # Increased from 35 to 40
        'all_moments': filtered
    }

def main():
    if not os.path.exists(AUDIO_FOLDER):
        os.makedirs(AUDIO_FOLDER)
        print(f"📁 Created '{AUDIO_FOLDER}' folder")
        print("👉 Add .mp3 or .wav files!\n")
        return
    
    audio_files = [f for f in os.listdir(AUDIO_FOLDER) 
                   if f.lower().endswith(('.mp3', '.wav', '.m4a'))]
    
    if not audio_files:
        print(f"❌ No audio files in '{AUDIO_FOLDER}'\n")
        return
    
    # Load existing results if any
    existing_results = {}
    if os.path.exists(OUTPUT_JSON):
        with open(OUTPUT_JSON, 'r') as f:
            existing_results = json.load(f)
    
    # Show available songs
    print(f"🎧 Found {len(audio_files)} audio file(s):\n")
    for i, audio_file in enumerate(audio_files, 1):
        analyzed = "✅ Analyzed" if audio_file in existing_results else "⭕ Not analyzed"
        audio_path = os.path.join(AUDIO_FOLDER, audio_file)
        
        # Get duration
        try:
            y, sr = librosa.load(audio_path, sr=44100, duration=1.0)  # Just load 1s to get info
            duration = librosa.get_duration(path=audio_path)
            print(f"  {i}. {audio_file}")
            print(f"     Duration: {duration:.2f}s | {analyzed}")
        except:
            print(f"  {i}. {audio_file} | {analyzed}")
    
    print("\n" + "="*60)
    
    # Get user choice
    while True:
        choice = input("\n🎯 Enter song number (or 'all' for all songs, 'q' to quit): ").strip().lower()
        
        if choice == 'q':
            print("👋 Exiting...\n")
            return
        
        if choice == 'all':
            selected_files = audio_files
            break
        
        try:
            song_idx = int(choice) - 1
            if 0 <= song_idx < len(audio_files):
                selected_files = [audio_files[song_idx]]
                break
            else:
                print(f"❌ Please enter a number between 1 and {len(audio_files)}")
        except ValueError:
            print("❌ Please enter a valid number, 'all', or 'q'")
    
    print("\n" + "="*60 + "\n")
    
    results = existing_results.copy()
    
    for audio_file in selected_files:
        audio_path = os.path.join(AUDIO_FOLDER, audio_file)
        try:
            analysis = analyze_with_pure_ai(audio_path)
            results[audio_file] = analysis
            
            # Save after each analysis (in case of crash)
            with open(OUTPUT_JSON, 'w') as f:
                json.dump(results, f, indent=2)
            
        except Exception as e:
            print(f"❌ Error: {e}\n")
            import traceback
            traceback.print_exc()
            continue
    
    print(f"{'='*60}")
    print(f"✅ Analysis saved to '{OUTPUT_JSON}'")
    print(f"{'='*60}\n")
    
    # Print results for selected files
    print("🤖 AI-DETECTED CUT POINTS:\n")
    for filename in selected_files:
        if filename not in results:
            continue
            
        data = results[filename]
        print(f"🎵 {filename}")
        print(f"   AI Model: {data['ai_model']}")
        print(f"   BPM: {data['bpm']:.1f} | Drum hits: {data['total_drum_hits']}")
        print(f"{'─'*60}")
        
        for i, point in enumerate(data['cut_points'][:20], 1):
            emoji = {
                'bass_drop': '🎢',
                'vocal_change': '🎤',
                'downbeat': '🥁',
                'strong_hit': '💥'
            }.get(point['type'], '🤖')
            
            print(f"  {i:2d}. {point['timestamp']:6.2f}s {emoji} {point['type']:15s} (score: {point['score']})")
            print(f"      {point['description']}")
        
        print()

if __name__ == "__main__":
    main()