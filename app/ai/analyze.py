# analyze.py - Advanced multi-band beat detection system
import os
import json
import torch
import numpy as np
from demucs import pretrained
from demucs.apply import apply_model
import librosa
from scipy.signal import find_peaks, butter, filtfilt
from scipy.ndimage import gaussian_filter1d, median_filter
from sklearn.metrics.pairwise import cosine_similarity
from datetime import datetime

AUDIO_FOLDER = "../backend/uploads/songs"
OUTPUT_JSON = "audio_analysis.json"

# === CONFIGURATION ===
MAX_DURATION = 60  # Maximum duration to analyze and generate (in seconds)
# Change this to analyze/generate longer videos (e.g., 120 for 2 minutes, None for full song)

# Density presets
DENSITY_PRESETS = {
    'low': {'min_distance': 1.0, 'score_threshold': 70, 'max_cuts': 30},
    'medium': {'min_distance': 0.5, 'score_threshold': 50, 'max_cuts': 60},
    'high': {'min_distance': 0.25, 'score_threshold': 35, 'max_cuts': 90},
    'insane': {'min_distance': 0.15, 'score_threshold': 25, 'max_cuts': 150}
}

def bandpass_filter(data, lowcut, highcut, sr, order=4):
    nyq = 0.5 * sr

    # Clamp cutoff frequencies to valid range
    low = max(1e-5, lowcut / nyq)
    high = min(0.999, highcut / nyq)

    if low >= high:
        # fallback to lowpass instead of bandpass
        low = 1e-5

    b, a = butter(order, [low, high], btype='band')
    return filtfilt(b, a, data)

def compute_onset_strength(audio, sr, hop_length=512):
    """Compute onset strength envelope with spectral flux"""
    # Compute STFT
    S = np.abs(librosa.stft(audio, n_fft=2048, hop_length=hop_length))
    
    # Spectral flux (difference between frames)
    flux = np.diff(S, axis=1)
    flux = np.maximum(0, flux)  # Only increases
    onset_env = np.sum(flux, axis=0)
    
    # Smooth
    onset_env = gaussian_filter1d(onset_env, sigma=2)
    
    return onset_env

def detect_multiband_onsets(audio, sr, hop_length=512):
    """Detect onsets in low/mid/high frequency bands"""
    
    # Define bands
    bands = {
        'low': (20, 250),      # Kick
        'mid': (250, 4000),    # Snare, vocals
        'high': (4000, 16000)  # Hi-hats
    }
    
    onsets = {}
    times = librosa.frames_to_time(np.arange(len(audio) // hop_length), sr=sr, hop_length=hop_length)
    
    for band_name, (low, high) in bands.items():
        # Filter to band
        filtered = bandpass_filter(audio, low, high, sr)
        
        # Compute RMS energy
        rms = librosa.feature.rms(y=filtered, frame_length=2048, hop_length=hop_length)[0]
        
        # Smooth
        rms = gaussian_filter1d(rms, sigma=2)
        
        # Normalize
        if np.max(rms) > 0:
            rms = rms / np.max(rms)
        
        # Adaptive threshold
        threshold = np.mean(rms) + 0.3 * np.std(rms)
        
        # Find peaks
        peaks, properties = find_peaks(
            rms,
            height=threshold,
            distance=int(0.05 * sr / hop_length),  # 50ms minimum
            prominence=0.05
        )
        
        onset_times = times[peaks]
        onset_strengths = properties['peak_heights']
        
        onsets[band_name] = {
            'times': onset_times,
            'strengths': onset_strengths,
            'envelope': rms
        }
    
    return onsets, times

def estimate_bpm_and_beats(drum_audio, sr):
    """Estimate BPM and generate beat grid"""
    # Compute onset envelope
    onset_env = librosa.onset.onset_strength(y=drum_audio, sr=sr, hop_length=512)
    
    # Estimate tempo
    tempo_result, beats = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr, hop_length=512)
    
    # Convert tempo to scalar (librosa sometimes returns array)
    tempo = float(tempo_result) if isinstance(tempo_result, np.ndarray) else float(tempo_result)
    
    # Get beat times
    beat_times = librosa.frames_to_time(beats, sr=sr, hop_length=512)
    
    # Generate finer grid (1/16 notes)
    if tempo > 0:
        beat_interval = 60.0 / tempo
        sixteenth_interval = beat_interval / 4
        
        # Generate grid
        duration = len(drum_audio) / sr
        grid_times = np.arange(0, duration, float(sixteenth_interval))
        
        # Find phase offset (align to first beat)
        if len(beat_times) > 0:
            offset = beat_times[0] % sixteenth_interval
            grid_times = grid_times + offset
    else:
        grid_times = beat_times
    
    return tempo, beat_times, grid_times

def detect_vocal_repetitions(vocal_audio, sr, hop_length=512):
    """Detect repeating vocal patterns (word repetitions, syllable stutters)"""
    # Compute MFCC features (captures vocal timbre/shape)
    mfcc = librosa.feature.mfcc(y=vocal_audio, sr=sr, n_mfcc=13, hop_length=hop_length)
    
    # Compute energy envelope
    rms = librosa.feature.rms(y=vocal_audio, frame_length=2048, hop_length=hop_length)[0]
    rms = gaussian_filter1d(rms, sigma=2)
    
    times = librosa.frames_to_time(np.arange(mfcc.shape[1]), sr=sr, hop_length=hop_length)
    
    repetitions = []
    
    # Window size for checking repetitions (0.3-1.0 seconds)
    min_window = int(0.3 * sr / hop_length)
    max_window = int(1.0 * sr / hop_length)
    
    # Slide through and find repeated patterns
    for i in range(len(times) - max_window):
        # Get current segment features
        segment1 = mfcc[:, i:i+min_window]
        
        if segment1.shape[1] < min_window:
            continue
        
        # Look ahead for similar patterns
        for offset in range(min_window, max_window):
            if i + offset + min_window >= mfcc.shape[1]:
                break
            
            segment2 = mfcc[:, i+offset:i+offset+min_window]
            
            if segment2.shape[1] < min_window:
                continue
            
            # Compute similarity
            similarity = cosine_similarity(segment1.T, segment2.T).mean()
            
            # Check if energy is also similar (not just silence)
            energy1 = np.mean(rms[i:i+min_window])
            energy2 = np.mean(rms[i+offset:i+offset+min_window])
            
            # Both must have energy and be similar
            if similarity > 0.7 and energy1 > 0.05 and energy2 > 0.05:
                time_gap = times[i+offset] - times[i]
                
                # Rapid repetition (< 1 second apart) is what we want
                if time_gap < 1.0:
                    # Check if not already detected
                    is_duplicate = any(
                        abs(times[i+offset] - rep['time']) < 0.3 
                        for rep in repetitions
                    )
                    
                    if not is_duplicate:
                        repetitions.append({
                            'time': times[i+offset],
                            'similarity': similarity,
                            'gap': time_gap,
                            'strength': (similarity * energy2)
                        })
                        break  # Found repetition for this position
    
    return repetitions

def detect_vocal_transients(vocal_audio, sr, hop_length=512):
    """Detect vocal consonant attacks using spectral flux"""
    # Focus on consonant frequency range (1-4 kHz)
    filtered = bandpass_filter(vocal_audio, 1000, 4000, sr)
    
    # Compute spectral flux
    onset_env = compute_onset_strength(filtered, sr, hop_length)
    
    # Adaptive threshold
    threshold = np.mean(onset_env) + 0.5 * np.std(onset_env)
    
    # Find peaks
    times = librosa.frames_to_time(np.arange(len(onset_env)), sr=sr, hop_length=hop_length)
    peaks, properties = find_peaks(
        onset_env,
        height=threshold,
        distance=int(0.08 * sr / hop_length),  # 80ms minimum
        prominence=np.std(onset_env) * 0.3
    )
    
    vocal_times = times[peaks]
    vocal_strengths = properties['peak_heights']
    
    return vocal_times, vocal_strengths

def detect_bass_drops(bass_audio, sr, hop_length=512):
    """Detect bass drops and heavy bass moments"""
    # Low frequency energy
    filtered = bandpass_filter(bass_audio, 20, 150, sr)
    
    # RMS energy
    rms = librosa.feature.rms(y=filtered, frame_length=2048, hop_length=hop_length)[0]
    rms = gaussian_filter1d(rms, sigma=3)
    
    times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop_length)
    
    drops = []
    
    # Detect sudden increases
    window = int(0.5 * sr / hop_length)
    for i in range(window, len(rms) - window, window // 4):
        before = np.mean(rms[i - window:i])
        after = np.mean(rms[i:i + window])
        
        if after > before * 1.5 and before > 0.001:
            drops.append({
                'time': times[i],
                'intensity': after / before,
                'type': 'increase'
            })
    
    # Also detect peaks
    if np.max(rms) > 0:
        rms_norm = rms / np.max(rms)
        peaks, props = find_peaks(
            rms_norm,
            height=0.4,
            distance=int(1.0 * sr / hop_length),
            prominence=0.15
        )
        
        for peak in peaks:
            drops.append({
                'time': times[peak],
                'intensity': rms_norm[peak],
                'type': 'peak'
            })
    
    return drops

def detect_drum_pattern_changes(drum_audio, sr, segment_duration=2.0):
    """Detect when drum pattern changes (fills, transitions)"""
    hop_length = 512
    segment_frames = int(segment_duration * sr / hop_length)
    
    # Get multi-band onsets
    onsets, times = detect_multiband_onsets(drum_audio, sr, hop_length)
    
    # Extract features per segment
    num_segments = len(times) // segment_frames
    features = []
    
    for i in range(num_segments):
        start_idx = i * segment_frames
        end_idx = (i + 1) * segment_frames
        
        if end_idx > len(times):
            break
        
        # Count onsets per band in this segment
        segment_feature = []
        for band_name in ['low', 'mid', 'high']:
            band_onsets = onsets[band_name]['times']
            count = np.sum((band_onsets >= times[start_idx]) & (band_onsets < times[end_idx]))
            segment_feature.append(count)
            
            # Also add energy
            energy = np.mean(onsets[band_name]['envelope'][start_idx:end_idx])
            segment_feature.append(energy)
        
        features.append(segment_feature)
    
    # Compute similarity between adjacent segments
    changes = []
    for i in range(1, len(features)):
        f1 = np.array(features[i-1]).reshape(1, -1)
        f2 = np.array(features[i]).reshape(1, -1)
        
        similarity = cosine_similarity(f1, f2)[0, 0]
        distance = 1 - similarity
        
        if distance > 0.3:  # Significant change
            change_time = times[i * segment_frames]
            changes.append({
                'time': change_time,
                'distance': distance
            })
    
    return changes

def snap_to_grid(time, grid_times, max_distance=0.05):
    """Snap time to nearest grid point if within max_distance"""
    if len(grid_times) == 0:
        return time, False
    
    distances = np.abs(grid_times - time)
    nearest_idx = np.argmin(distances)
    nearest_time = grid_times[nearest_idx]
    distance = distances[nearest_idx]
    
    if distance < max_distance:
        return nearest_time, True
    else:
        return time, False

def score_cut_point(event, beat_times, grid_times, pattern_changes, bar_length):
    """Score a cut point based on multiple factors"""
    time = event['time']
    score = 0
    
    # Base score from transient strength
    score += event.get('strength', 0.5) * 30
    
    # Multi-band agreement bonus
    score += event.get('multi_band', 0) * 20
    
    # Check if on beat
    if len(beat_times) > 0:
        beat_distances = np.abs(beat_times - time)
        if np.min(beat_distances) < 0.05:
            score += 15
            
            # Check if downbeat (first beat of bar)
            nearest_beat_idx = np.argmin(beat_distances)
            if nearest_beat_idx % 4 == 0:
                score += 15  # Downbeat bonus
    
    # Check if on grid
    if len(grid_times) > 0:
        if np.min(np.abs(grid_times - time)) < 0.05:
            score += 10
    
    # Pattern change bonus
    for change in pattern_changes:
        if abs(time - change['time']) < 0.5:
            score += 10
            break
    
    # Event type bonuses
    if event['type'] == 'bass_drop':
        score += 15
    elif event['type'] == 'vocal_transient':
        score += 8
    elif event['type'] == 'vocal_repetition':
        score += 18  # HIGH BONUS for repetitions!
        # Extra bonus for very rapid repetitions
        if event.get('gap', 1.0) < 0.5:
            score += 10  # "floor floor" type moments
    elif event['type'] == 'pattern_change':
        score += 12
    
    return min(score, 100)

def analyze_audio_advanced(
    audio_path,
    density='medium',
    aggressiveness=0.7,
    max_duration=None,  # NEW PARAMETER
    focus_bass=True,
    focus_vocals=True,
    focus_repetitions=True,
    sync_to_grid=False
):
    """Advanced multi-band audio analysis"""
    
    print(f"\n{'='*60}")
    print(f"🎵 Analyzing: {os.path.basename(audio_path)}")
    print(f"{'='*60}\n")
    print(f"⚙️  Settings: density={density}, aggressiveness={aggressiveness:.1f}")
    
    if max_duration:
        print(f"   Max duration: {max_duration}s, Bass: {focus_bass}, Vocals: {focus_vocals}, Repetitions: {focus_repetitions}\n")
    else:
        print(f"   Full song, Bass: {focus_bass}, Vocals: {focus_vocals}, Repetitions: {focus_repetitions}\n")
    
    # Load Demucs
    print("🤖 Loading Demucs AI model...")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = pretrained.get_model('htdemucs')
    model.to(device)
    model.eval()
    
    # Load audio
    print("📂 Loading audio...")
    wav_np, sr = librosa.load(audio_path, sr=22050, mono=False)  # 22050 for speed
    
    if wav_np.ndim == 1:
        wav_np = np.stack([wav_np, wav_np])
    elif wav_np.shape[0] == 1:
        wav_np = np.vstack([wav_np, wav_np])
    
    full_duration = wav_np.shape[1] / sr
    
    # Apply max duration limit
    if max_duration and max_duration > 0:
        max_samples = int(max_duration * sr)
        wav_np = wav_np[:, :max_samples]
        duration = min(max_duration, full_duration)
        print(f"   ⏱️  Processing first {duration:.2f}s (of {full_duration:.2f}s total)\n")
    else:
        duration = full_duration
        print(f"   Duration: {duration:.2f}s | Sample rate: {sr}Hz\n")
    
    # AI separation
    print("🎛️  Running AI source separation...")
    wav = torch.from_numpy(wav_np).float()
    
    with torch.no_grad():
        wav_tensor = wav.unsqueeze(0).to(device)
        sources = apply_model(model, wav_tensor, device=device)[0]
    
    drums = sources[0].cpu().numpy()
    bass = sources[1].cpu().numpy()
    vocals = sources[3].cpu().numpy()
    
    # Convert to mono
    drum_mono = np.mean(drums, axis=0)
    bass_mono = np.mean(bass, axis=0)
    vocal_mono = np.mean(vocals, axis=0)
    
    print("   ✅ Separation complete!\n")
    
    # Estimate tempo and beats
    print("🎼 Estimating tempo and beat grid...")
    tempo, beat_times, grid_times = estimate_bpm_and_beats(drum_mono, sr)
    print(f"   BPM: {tempo:.1f}\n")
    
    # Multi-band onset detection
    print("🥁 Multi-band onset detection (kick/snare/hat)...")
    drum_onsets, times = detect_multiband_onsets(drum_mono, sr)
    print(f"   Low (kick): {len(drum_onsets['low']['times'])} onsets")
    print(f"   Mid (snare): {len(drum_onsets['mid']['times'])} onsets")
    print(f"   High (hats): {len(drum_onsets['high']['times'])} onsets\n")
    
    # Vocal transients
    if focus_vocals:
        print("🎤 Detecting vocal transients...")
        vocal_times, vocal_strengths = detect_vocal_transients(vocal_mono, sr)
        print(f"   Found {len(vocal_times)} vocal hits\n")
    else:
        vocal_times, vocal_strengths = np.array([]), np.array([])
    
    # Vocal repetitions
    if focus_repetitions:
        print("🔁 Detecting vocal repetitions (repeated words/syllables)...")
        vocal_repetitions = detect_vocal_repetitions(vocal_mono, sr)
        print(f"   Found {len(vocal_repetitions)} repetition patterns\n")
    else:
        vocal_repetitions = []
    
    # Bass drops
    if focus_bass:
        print("🎢 Detecting bass drops...")
        bass_drops = detect_bass_drops(bass_mono, sr)
        print(f"   Found {len(bass_drops)} bass moments\n")
    else:
        bass_drops = []
    
    # Drum pattern changes
    print("🔄 Detecting drum pattern changes...")
    pattern_changes = detect_drum_pattern_changes(drum_mono, sr)
    print(f"   Found {len(pattern_changes)} pattern changes\n")
    
    # Collect all candidate events
    print("✨ Scoring and filtering cut points...\n")
    
    candidates = []
    bar_length = (60.0 / tempo) * 4 if tempo > 0 else 4.0
    
    # Add drum onsets
    for band_name in ['low', 'mid', 'high']:
        for t, s in zip(drum_onsets[band_name]['times'], drum_onsets[band_name]['strengths']):
            candidates.append({
                'time': t,
                'strength': s,
                'type': f'drum_{band_name}',
                'multi_band': 0
            })
    
    # Add vocal transients
    for t, s in zip(vocal_times, vocal_strengths):
        candidates.append({
            'time': t,
            'strength': s,
            'type': 'vocal_transient',
            'multi_band': 0
        })
    
    # Add vocal repetitions
    for rep in vocal_repetitions:
        candidates.append({
            'time': rep['time'],
            'strength': rep['strength'],
            'type': 'vocal_repetition',
            'multi_band': 0,
            'gap': rep['gap'],
            'similarity': rep['similarity']
        })
    
    # Add bass drops
    for drop in bass_drops:
        candidates.append({
            'time': drop['time'],
            'strength': drop['intensity'],
            'type': 'bass_drop',
            'multi_band': 0
        })
    
    # Add pattern changes
    for change in pattern_changes:
        candidates.append({
            'time': change['time'],
            'strength': change['distance'],
            'type': 'pattern_change',
            'multi_band': 0
        })
    
    # Check multi-band agreement
    for candidate in candidates:
        time = candidate['time']
        agreements = 0
        for band_name in ['low', 'mid', 'high']:
            if np.any(np.abs(drum_onsets[band_name]['times'] - time) < 0.03):
                agreements += 1
        candidate['multi_band'] = agreements / 3.0
    
    # Score each candidate
    preset = DENSITY_PRESETS[density]
    threshold_multiplier = 1.0 - (aggressiveness * 0.3)
    adjusted_threshold = preset['score_threshold'] * threshold_multiplier
    
    scored_candidates = []
    for candidate in candidates:
        score = score_cut_point(candidate, beat_times, grid_times, pattern_changes, bar_length)
        
        if score >= adjusted_threshold:
            # Snap to grid if enabled
            time = candidate['time']
            if sync_to_grid:
                time, snapped = snap_to_grid(time, grid_times)
            else:
                time, snapped = snap_to_grid(time, grid_times, max_distance=0.05)
            
            scored_candidates.append({
                'timestamp': float(time),
                'score': int(score),
                'type': candidate['type'],
                'strength': float(candidate['strength']),
                'on_grid': snapped,
                'description': f"{candidate['type'].replace('_', ' ').title()}",
                'repetition_gap': float(candidate.get('gap', 0)) if candidate['type'] == 'vocal_repetition' else None
            })
    
    # Remove duplicates (within min_distance)
    scored_candidates.sort(key=lambda x: x['timestamp'])
    filtered = []
    
    for candidate in scored_candidates:
        if not filtered or (candidate['timestamp'] - filtered[-1]['timestamp']) >= preset['min_distance']:
            filtered.append(candidate)
        elif candidate['score'] > filtered[-1]['score']:
            filtered[-1] = candidate
    
    # Sort by score
    filtered.sort(key=lambda x: (-x['score'], x['timestamp']))
    
    # Limit to max cuts
    filtered = filtered[:preset['max_cuts']]
    
    print(f"✅ Generated {len(filtered)} cut points (threshold: {adjusted_threshold:.1f})\n")
    
    return {
        'last_analyzed': datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        'duration': float(duration),
        'full_duration': float(full_duration),
        'max_duration': max_duration,
        'bpm': float(tempo),
        'beat_times': [float(t) for t in beat_times[:20]],
        'total_candidates': len(candidates),
        'cut_points': filtered,
        'settings': {
            'density': density,
            'aggressiveness': aggressiveness,
            'max_duration': max_duration,
            'focus_bass': focus_bass,
            'focus_vocals': focus_vocals,
            'focus_repetitions': focus_repetitions,
            'sync_to_grid': sync_to_grid
        }
    }

def main():
    """Main function that automatically runs analysis on first song with configured parameters"""
    # Get script directory for resolving relative paths
    script_dir = os.path.dirname(os.path.abspath(__file__))
    
    # Resolve paths relative to script directory
    audio_folder_abs = os.path.join(script_dir, AUDIO_FOLDER)
    output_json_abs = os.path.join(script_dir, OUTPUT_JSON)
    
    if not os.path.exists(audio_folder_abs):
        os.makedirs(audio_folder_abs)
        print(f"📁 Created '{AUDIO_FOLDER}' folder")
        print("👉 Add .mp3 or .wav files!\n")
        return
    
    audio_files = [f for f in os.listdir(audio_folder_abs) 
                   if f.lower().endswith(('.mp3', '.wav', '.m4a'))]
    
    if not audio_files:
        print(f"❌ No audio files in '{AUDIO_FOLDER}'\n")
        return
    
    # Get first song
    first_song = audio_files[0]
    audio_path = os.path.join(audio_folder_abs, first_song)
    
    print(f"🎵 Automatically analyzing first song: {first_song}")
    print(f"⚙️  Using configured parameters from MAX_DURATION = {MAX_DURATION}\n")
    
    # Load existing results
    existing_results = {}
    if os.path.exists(output_json_abs):
        with open(output_json_abs, 'r') as f:
            existing_results = json.load(f)
    
    # Run analysis with configured parameters
    try:
        analysis = analyze_audio_advanced(
            audio_path,
            density='medium',
            aggressiveness=0.7,
            max_duration=MAX_DURATION,  # Use configured max duration
            focus_bass=True,
            focus_vocals=True,
            focus_repetitions=True,
            sync_to_grid=False
        )
        
        results = existing_results.copy()
        results[first_song] = analysis
        
        # Save results
        with open(output_json_abs, 'w') as f:
            json.dump(results, f, indent=2)
        
        print(f"{'='*60}")
        print(f"✅ Analysis saved to '{OUTPUT_JSON}'")
        print(f"{'='*60}\n")
        
        # Print summary
        print("📊 CUT POINTS SUMMARY:\n")
        data = results[first_song]
        print(f"🎵 {first_song}")
        print(f"   BPM: {data['bpm']:.1f} | Analyzed: {data['duration']:.2f}s")
        if data.get('max_duration'):
            print(f"   (Limited to first {data['max_duration']}s of {data['full_duration']:.2f}s total)")
        print(f"   Cut points: {len(data['cut_points'])}")
        if 'total_candidates' in data:
            print(f"   Total candidates analyzed: {data['total_candidates']}")
        print(f"{'─'*60}")
        
        for i, point in enumerate(data['cut_points'][:15], 1):
            grid_icon = "🎯" if point.get('on_grid') else "⚪"
            
            # Show repetition gap for vocal repetitions
            extra_info = ""
            if point['type'] == 'vocal_repetition' and point.get('repetition_gap'):
                extra_info = f" [gap: {point['repetition_gap']:.2f}s]"
            
            print(f"  {i:2d}. {point['timestamp']:6.2f}s {grid_icon} {point['type']:20s} (score: {point['score']}){extra_info}")
        
        if len(data['cut_points']) > 15:
            print(f"  ... and {len(data['cut_points']) - 15} more")
        print()
        
    except Exception as e:
        print(f"❌ Error: {e}\n")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()