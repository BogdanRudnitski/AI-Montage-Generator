# analyze.py - Advanced multi-band beat detection system
import os
import json
import torch
import numpy as np
from demucs import pretrained
from demucs.apply import apply_model
import librosa
from scipy.signal import find_peaks, butter, filtfilt
from scipy.ndimage import gaussian_filter1d
from sklearn.metrics.pairwise import cosine_similarity
from datetime import datetime

AUDIO_FOLDER    = "../backend/uploads/songs"
TAPS_FOLDER     = "../backend/uploads/taps"
OUTPUT_JSON     = "audio_analysis.json"
CALIBRATION_JSON = "calibration.json"

MAX_DURATION = int(os.environ.get('MAX_DURATION', '60'))

# tap_mode can be overridden per-request via env var (set by backend before subprocess call).
# Falls back to options.json value. Values: 'verbatim' | 'calibrate' | '' (AI only)
TAP_MODE_OVERRIDE = os.environ.get('TAP_MODE', None)  # '' means AI-only, None means use options.json

DENSITY_PRESETS = {
    'low':    {'min_distance': 1.0,  'score_threshold': 70,  'max_cuts': 30},
    'medium': {'min_distance': 0.5,  'score_threshold': 50,  'max_cuts': 60},
    'high':   {'min_distance': 0.25, 'score_threshold': 35,  'max_cuts': 90},
    'insane': {'min_distance': 0.15, 'score_threshold': 25,  'max_cuts': 150},
}

# ─── Tap helpers ──────────────────────────────────────────────────────────────

def _taps_path(song_filename):
    script_dir = os.path.dirname(os.path.abspath(__file__))
    taps_dir   = os.path.join(script_dir, TAPS_FOLDER)
    os.makedirs(taps_dir, exist_ok=True)
    stem = os.path.splitext(song_filename)[0]
    return os.path.join(taps_dir, f"{stem}.json")

def load_taps(song_filename):
    path = _taps_path(song_filename)
    if not os.path.exists(path):
        return None
    with open(path) as f:
        data = json.load(f)
    return [float(c['timestamp']) for c in data.get('manual_cuts', [])]

def taps_to_cut_points(tap_timestamps, max_duration):
    """Return tap timestamps as cut_points in the standard output schema."""
    return [
        {
            'timestamp':      float(t),
            'score':          100,
            'type':           'manual_tap',
            'strength':       1.0,
            'on_grid':        False,
            'description':    'Manual Tap',
            'repetition_gap': None,
        }
        for t in sorted(tap_timestamps)
        if float(t) <= max_duration
    ]

# ─── Calibration helpers ──────────────────────────────────────────────────────

def load_calibration(script_dir):
    path = os.path.join(script_dir, CALIBRATION_JSON)
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        return json.load(f)

def apply_calibration_to_preset(preset, calibration, song_key):
    """Merge per-song or global calibration values into a preset dict."""
    cal = calibration.get('songs', {}).get(song_key, {})
    if not cal:
        cal = calibration  # fall back to top-level global keys

    result = dict(preset)
    if 'min_distance' in cal:
        result['min_distance']    = cal['min_distance']
    if 'score_threshold' in cal:
        result['score_threshold'] = cal['score_threshold']
    return result, cal.get('type_bonuses', {})

# ─── DSP helpers ──────────────────────────────────────────────────────────────

def bandpass_filter(data, lowcut, highcut, sr, order=4):
    from scipy.signal import butter, filtfilt
    nyq  = 0.5 * sr
    low  = max(1e-5, lowcut  / nyq)
    high = min(0.999, highcut / nyq)
    if low >= high:
        low = 1e-5
    b, a = butter(order, [low, high], btype='band')
    return filtfilt(b, a, data)

def compute_onset_strength(audio, sr, hop_length=512):
    S        = np.abs(librosa.stft(audio, n_fft=2048, hop_length=hop_length))
    flux     = np.maximum(0, np.diff(S, axis=1))
    onset    = np.sum(flux, axis=0)
    return gaussian_filter1d(onset, sigma=2)

def detect_multiband_onsets(audio, sr, hop_length=512):
    bands = {'low': (20, 250), 'mid': (250, 4000), 'high': (4000, 16000)}
    times  = librosa.frames_to_time(np.arange(len(audio) // hop_length), sr=sr, hop_length=hop_length)
    onsets = {}
    for band_name, (lo, hi) in bands.items():
        filtered  = bandpass_filter(audio, lo, hi, sr)
        rms       = librosa.feature.rms(y=filtered, frame_length=2048, hop_length=hop_length)[0]
        rms       = gaussian_filter1d(rms, sigma=2)
        if np.max(rms) > 0:
            rms /= np.max(rms)
        threshold = np.mean(rms) + 0.3 * np.std(rms)
        peaks, props = find_peaks(rms, height=threshold,
                                  distance=int(0.05 * sr / hop_length), prominence=0.05)
        onsets[band_name] = {
            'times':     times[peaks],
            'strengths': props['peak_heights'],
            'envelope':  rms,
        }
    return onsets, times

def estimate_bpm_and_beats(drum_audio, sr):
    onset_env    = librosa.onset.onset_strength(y=drum_audio, sr=sr, hop_length=512)
    tempo_result, beats = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr, hop_length=512)
    tempo        = float(np.atleast_1d(tempo_result)[0])
    beat_times   = librosa.frames_to_time(beats, sr=sr, hop_length=512)
    if tempo > 0:
        sixteenth  = (60.0 / tempo) / 4
        duration   = len(drum_audio) / sr
        grid_times = np.arange(0, duration, float(sixteenth))
        if len(beat_times) > 0:
            grid_times += beat_times[0] % sixteenth
    else:
        grid_times = beat_times
    return tempo, beat_times, grid_times

def detect_vocal_repetitions(vocal_audio, sr, hop_length=512):
    mfcc       = librosa.feature.mfcc(y=vocal_audio, sr=sr, n_mfcc=13, hop_length=hop_length)
    rms        = gaussian_filter1d(
                     librosa.feature.rms(y=vocal_audio, frame_length=2048, hop_length=hop_length)[0],
                     sigma=2)
    times      = librosa.frames_to_time(np.arange(mfcc.shape[1]), sr=sr, hop_length=hop_length)
    min_win    = int(0.3 * sr / hop_length)
    max_win    = int(1.0 * sr / hop_length)
    reps       = []
    for i in range(len(times) - max_win):
        seg1 = mfcc[:, i:i+min_win]
        if seg1.shape[1] < min_win:
            continue
        for offset in range(min_win, max_win):
            if i + offset + min_win >= mfcc.shape[1]:
                break
            seg2 = mfcc[:, i+offset:i+offset+min_win]
            if seg2.shape[1] < min_win:
                continue
            sim   = cosine_similarity(seg1.T, seg2.T).mean()
            e1    = np.mean(rms[i:i+min_win])
            e2    = np.mean(rms[i+offset:i+offset+min_win])
            if sim > 0.7 and e1 > 0.05 and e2 > 0.05:
                gap = times[i+offset] - times[i]
                if gap < 1.0 and not any(abs(times[i+offset] - r['time']) < 0.3 for r in reps):
                    reps.append({'time': times[i+offset], 'similarity': sim,
                                 'gap': gap, 'strength': sim * e2})
                    break
    return reps

def detect_vocal_transients(vocal_audio, sr, hop_length=512):
    filtered  = bandpass_filter(vocal_audio, 1000, 4000, sr)
    onset     = compute_onset_strength(filtered, sr, hop_length)
    threshold = np.mean(onset) + 0.5 * np.std(onset)
    times     = librosa.frames_to_time(np.arange(len(onset)), sr=sr, hop_length=hop_length)
    peaks, props = find_peaks(onset, height=threshold,
                              distance=int(0.08 * sr / hop_length),
                              prominence=np.std(onset) * 0.3)
    return times[peaks], props['peak_heights']

def detect_bass_drops(bass_audio, sr, hop_length=512):
    filtered = bandpass_filter(bass_audio, 20, 150, sr)
    rms      = gaussian_filter1d(
                   librosa.feature.rms(y=filtered, frame_length=2048, hop_length=hop_length)[0],
                   sigma=3)
    times    = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop_length)
    drops    = []
    window   = int(0.5 * sr / hop_length)
    for i in range(window, len(rms) - window, window // 4):
        before = np.mean(rms[i-window:i])
        after  = np.mean(rms[i:i+window])
        if after > before * 1.5 and before > 0.001:
            drops.append({'time': times[i], 'intensity': after / before, 'type': 'increase'})
    if np.max(rms) > 0:
        rms_n = rms / np.max(rms)
        peaks, _ = find_peaks(rms_n, height=0.4,
                              distance=int(1.0 * sr / hop_length), prominence=0.15)
        for p in peaks:
            drops.append({'time': times[p], 'intensity': rms_n[p], 'type': 'peak'})
    return drops

def detect_drum_pattern_changes(drum_audio, sr, segment_duration=2.0):
    hop_length     = 512
    segment_frames = int(segment_duration * sr / hop_length)
    onsets, times  = detect_multiband_onsets(drum_audio, sr, hop_length)
    num_segments   = len(times) // segment_frames
    features       = []
    for i in range(num_segments):
        s, e = i * segment_frames, (i+1) * segment_frames
        if e > len(times):
            break
        feat = []
        for band in ['low', 'mid', 'high']:
            bt  = onsets[band]['times']
            feat.append(np.sum((bt >= times[s]) & (bt < times[e])))
            feat.append(np.mean(onsets[band]['envelope'][s:e]))
        features.append(feat)
    changes = []
    for i in range(1, len(features)):
        f1 = np.array(features[i-1]).reshape(1, -1)
        f2 = np.array(features[i]).reshape(1, -1)
        dist = 1 - cosine_similarity(f1, f2)[0, 0]
        if dist > 0.3:
            changes.append({'time': times[i * segment_frames], 'distance': dist})
    return changes

def snap_to_grid(time, grid_times, max_distance=0.05):
    if len(grid_times) == 0:
        return time, False
    dists = np.abs(grid_times - time)
    idx   = np.argmin(dists)
    return (grid_times[idx], True) if dists[idx] < max_distance else (time, False)

# ─── Scoring ──────────────────────────────────────────────────────────────────

def score_cut_point(event, beat_times, grid_times, pattern_changes, bar_length,
                    type_bonuses=None):
    time   = event['time']
    score  = 0
    score += event.get('strength', 0.5) * 30
    score += event.get('multi_band', 0) * 20

    if len(beat_times) > 0:
        bd = np.abs(beat_times - time)
        if np.min(bd) < 0.05:
            score += 15
            if np.argmin(bd) % 4 == 0:
                score += 15

    if len(grid_times) > 0 and np.min(np.abs(grid_times - time)) < 0.05:
        score += 10

    for change in pattern_changes:
        if abs(time - change['time']) < 0.5:
            score += 10
            break

    type_base = {
        'bass_drop':        15,
        'vocal_transient':   8,
        'vocal_repetition': 18,
        'pattern_change':   12,
    }
    score += type_base.get(event['type'], 0)
    if event['type'] == 'vocal_repetition' and event.get('gap', 1.0) < 0.5:
        score += 10

    # Calibration type bonus
    if type_bonuses:
        score += type_bonuses.get(event['type'], 0)

    return min(int(score), 100)

# ─── Main analysis ────────────────────────────────────────────────────────────

def analyze_audio_advanced(
    audio_path,
    density='medium',
    aggressiveness=0.7,
    max_duration=None,
    focus_bass=True,
    focus_vocals=True,
    focus_repetitions=True,
    sync_to_grid=False,
    tap_mode=None,          # None | 'verbatim' | 'calibrate'
):
    """
    tap_mode=None       → pure AI analysis
    tap_mode='verbatim' → use tap timestamps directly, skip AI
    tap_mode='calibrate'→ run AI analysis but apply calibration.json learnt from taps
    """
    script_dir   = os.path.dirname(os.path.abspath(__file__))
    song_filename = os.path.basename(audio_path)
    song_key     = os.path.splitext(song_filename)[0]

    print(f"\n{'='*60}")
    print(f"🎵 Analyzing: {song_filename}")
    if tap_mode:
        print(f"   Tap mode: {tap_mode}")
    print(f"{'='*60}\n")
    print(f"⚙️  Settings: density={density}, aggressiveness={aggressiveness:.1f}")
    if max_duration:
        print(f"   Max duration: {max_duration}s\n")

    # ── Real audio metadata (always needed) ───────────────────────────────────
    wav_np, sr = librosa.load(audio_path, sr=22050, mono=False)
    if wav_np.ndim == 1:
        wav_np = np.stack([wav_np, wav_np])
    elif wav_np.shape[0] == 1:
        wav_np = np.vstack([wav_np, wav_np])

    full_duration = wav_np.shape[1] / sr
    if max_duration and max_duration > 0:
        wav_np   = wav_np[:, :int(max_duration * sr)]
        duration = min(max_duration, full_duration)
    else:
        duration = full_duration

    print(f"   ⏱️  {duration:.2f}s (of {full_duration:.2f}s total)\n")

    # ── VERBATIM TAP MODE ─────────────────────────────────────────────────────
    if tap_mode == 'verbatim':
        taps = load_taps(song_filename)
        if taps is None:
            print("⚠️  No tap file found — falling back to AI analysis.\n")
            tap_mode = None
        else:
            cut_points = taps_to_cut_points(taps, duration)
            print(f"✅ Using {len(cut_points)} manual taps verbatim\n")

            # Still get BPM from drums for metadata
            mono = np.mean(wav_np, axis=0)
            onset_env = librosa.onset.onset_strength(y=mono, sr=sr)
            tempo_r, beats = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr)
            tempo      = float(np.atleast_1d(tempo_r)[0])
            beat_times = librosa.frames_to_time(beats, sr=sr).tolist()[:20]

            return _build_result(song_filename, cut_points, duration, full_duration,
                                 max_duration, tempo, beat_times, len(taps),
                                 density, aggressiveness, focus_bass, focus_vocals,
                                 focus_repetitions, sync_to_grid)

    # ── AI ANALYSIS (shared by None and 'calibrate') ──────────────────────────
    print("🤖 Loading Demucs AI model...")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model  = pretrained.get_model('htdemucs')
    model.to(device).eval()

    print("🎛️  Running AI source separation...")
    with torch.no_grad():
        sources = apply_model(model, torch.from_numpy(wav_np).float().unsqueeze(0).to(device), device=device)[0]
    drum_mono  = np.mean(sources[0].cpu().numpy(), axis=0)
    bass_mono  = np.mean(sources[1].cpu().numpy(), axis=0)
    vocal_mono = np.mean(sources[3].cpu().numpy(), axis=0)
    print("   ✅ Separation complete!\n")

    print("🎼 Estimating tempo and beat grid...")
    tempo, beat_times, grid_times = estimate_bpm_and_beats(drum_mono, sr)
    print(f"   BPM: {tempo:.1f}\n")

    print("🥁 Multi-band onset detection...")
    drum_onsets, _ = detect_multiband_onsets(drum_mono, sr)
    print(f"   Low: {len(drum_onsets['low']['times'])}  "
          f"Mid: {len(drum_onsets['mid']['times'])}  "
          f"High: {len(drum_onsets['high']['times'])}\n")

    vocal_times, vocal_strengths = (detect_vocal_transients(vocal_mono, sr)
                                    if focus_vocals else (np.array([]), np.array([])))
    if focus_vocals:
        print(f"🎤 Vocal transients: {len(vocal_times)}\n")

    vocal_reps = detect_vocal_repetitions(vocal_mono, sr) if focus_repetitions else []
    if focus_repetitions:
        print(f"🔁 Vocal repetitions: {len(vocal_reps)}\n")

    bass_drops = detect_bass_drops(bass_mono, sr) if focus_bass else []
    if focus_bass:
        print(f"🎢 Bass drops: {len(bass_drops)}\n")

    print("🔄 Detecting drum pattern changes...")
    pattern_changes = detect_drum_pattern_changes(drum_mono, sr)
    print(f"   Found {len(pattern_changes)} pattern changes\n")

    # ── Build candidates ──────────────────────────────────────────────────────
    candidates = []
    for band in ['low', 'mid', 'high']:
        for t, s in zip(drum_onsets[band]['times'], drum_onsets[band]['strengths']):
            candidates.append({'time': t, 'strength': s, 'type': f'drum_{band}', 'multi_band': 0})
    for t, s in zip(vocal_times, vocal_strengths):
        candidates.append({'time': t, 'strength': s, 'type': 'vocal_transient', 'multi_band': 0})
    for rep in vocal_reps:
        candidates.append({'time': rep['time'], 'strength': rep['strength'],
                           'type': 'vocal_repetition', 'multi_band': 0,
                           'gap': rep['gap'], 'similarity': rep['similarity']})
    for drop in bass_drops:
        candidates.append({'time': drop['time'], 'strength': drop['intensity'],
                           'type': 'bass_drop', 'multi_band': 0})
    for change in pattern_changes:
        candidates.append({'time': change['time'], 'strength': change['distance'],
                           'type': 'pattern_change', 'multi_band': 0})

    for c in candidates:
        c['multi_band'] = sum(
            1 for band in ['low', 'mid', 'high']
            if np.any(np.abs(drum_onsets[band]['times'] - c['time']) < 0.03)
        ) / 3.0

    # ── Load calibration if in calibrate mode ─────────────────────────────────
    type_bonuses = {}
    preset       = dict(DENSITY_PRESETS[density])

    if tap_mode == 'calibrate':
        calibration = load_calibration(script_dir)
        if calibration:
            preset, type_bonuses = apply_calibration_to_preset(preset, calibration, song_key)
            print(f"🎯 Calibration loaded — min_dist={preset['min_distance']}  "
                  f"threshold={preset['score_threshold']}  "
                  f"type_bonuses={type_bonuses}\n")
        else:
            print("⚠️  No calibration.json found — running uncalibrated AI analysis.\n")

    # ── Score & filter ────────────────────────────────────────────────────────
    bar_length         = (60.0 / tempo) * 4 if tempo > 0 else 4.0
    adjusted_threshold = preset['score_threshold'] * (1.0 - aggressiveness * 0.3)

    print(f"✨ Scoring {len(candidates)} candidates (threshold: {adjusted_threshold:.1f})...\n")

    scored = []
    for c in candidates:
        score = score_cut_point(c, beat_times, grid_times, pattern_changes,
                                bar_length, type_bonuses)
        if score < adjusted_threshold:
            continue
        t, snapped = (snap_to_grid(c['time'], grid_times)
                      if sync_to_grid
                      else snap_to_grid(c['time'], grid_times, max_distance=0.05))
        scored.append({
            'timestamp':      float(t),
            'score':          int(score),
            'type':           c['type'],
            'strength':       float(c['strength']),
            'on_grid':        snapped,
            'description':    c['type'].replace('_', ' ').title(),
            'repetition_gap': float(c.get('gap', 0)) if c['type'] == 'vocal_repetition' else None,
        })

    scored.sort(key=lambda x: x['timestamp'])
    deduped = []
    for c in scored:
        if not deduped or (c['timestamp'] - deduped[-1]['timestamp']) >= preset['min_distance']:
            deduped.append(c)
        elif c['score'] > deduped[-1]['score']:
            deduped[-1] = c

    max_cuts = preset['max_cuts']
    if len(deduped) > max_cuts:
        bucket_w = duration / max_cuts
        buckets  = [[] for _ in range(max_cuts)]
        for c in deduped:
            if c['timestamp'] < duration:
                buckets[min(int(c['timestamp'] / bucket_w), max_cuts - 1)].append(c)
        filtered = sorted(
            [max(b, key=lambda x: (x['score'], -x['timestamp'])) for b in buckets if b],
            key=lambda x: x['timestamp']
        )
    else:
        filtered = deduped

    print(f"✅ Generated {len(filtered)} cut points\n")

    return _build_result(song_filename, filtered, duration, full_duration,
                         max_duration, tempo, beat_times[:20].tolist() if hasattr(beat_times, 'tolist') else list(beat_times)[:20],
                         len(candidates), density, aggressiveness,
                         focus_bass, focus_vocals, focus_repetitions, sync_to_grid)


def _build_result(song_filename, cut_points, duration, full_duration, max_duration,
                  tempo, beat_times, total_candidates, density, aggressiveness,
                  focus_bass, focus_vocals, focus_repetitions, sync_to_grid):
    return {
        'last_analyzed':    datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        'duration':         float(duration),
        'full_duration':    float(full_duration),
        'max_duration':     max_duration,
        'bpm':              float(tempo),
        'beat_times':       [float(t) for t in beat_times],
        'total_candidates': total_candidates,
        'cut_points':       cut_points,
        'settings': {
            'density':            density,
            'aggressiveness':     aggressiveness,
            'max_duration':       max_duration,
            'focus_bass':         focus_bass,
            'focus_vocals':       focus_vocals,
            'focus_repetitions':  focus_repetitions,
            'sync_to_grid':       sync_to_grid,
        },
    }

# ─── CLI entry point ──────────────────────────────────────────────────────────

def main():
    script_dir       = os.path.dirname(os.path.abspath(__file__))
    project_root     = os.path.dirname(script_dir)
    audio_folder_abs = os.path.join(script_dir, AUDIO_FOLDER)
    output_json_abs  = os.path.join(script_dir, OUTPUT_JSON)
    options_file     = os.path.join(project_root, "backend", "uploads", "options.json")

    if not os.path.exists(audio_folder_abs):
        os.makedirs(audio_folder_abs)
        print(f"📁 Created '{AUDIO_FOLDER}' folder — add .mp3/.wav files!\n")
        return

    audio_files = [f for f in os.listdir(audio_folder_abs)
                   if f.lower().endswith(('.mp3', '.wav', '.m4a'))
                   or ('.' not in f and not f.startswith('.'))]
    if not audio_files:
        print(f"❌ No audio files in '{AUDIO_FOLDER}'\n")
        return

    # Defaults
    target_song       = None
    density           = 'medium'
    aggressiveness    = 0.7
    focus_bass        = True
    focus_vocals      = True
    focus_repetitions = True
    sync_to_grid      = False
    tap_mode          = None   # None | 'verbatim' | 'calibrate'

    if os.path.exists(options_file):
        try:
            with open(options_file) as f:
                opts = json.load(f)
            target_song       = opts.get('song_filename')
            density           = opts.get('density', density)
            aggressiveness    = opts.get('aggressiveness', aggressiveness)
            focus_bass        = opts.get('focus_bass', focus_bass)
            focus_vocals      = opts.get('focus_vocals', focus_vocals)
            focus_repetitions = opts.get('focus_repetitions', focus_repetitions)
            sync_to_grid      = opts.get('sync_to_grid', sync_to_grid)
            tap_mode          = opts.get('tap_mode', tap_mode)  # 'verbatim' | 'calibrate' | null
            print(f"📋 Options loaded  tap_mode={tap_mode}  density={density}  aggressiveness={aggressiveness}")
        except Exception as e:
            print(f"⚠️  options.json error: {e} — using defaults")

    # Per-request override beats options.json (set by backend via TAP_MODE env var).
    if TAP_MODE_OVERRIDE is not None:
        tap_mode = TAP_MODE_OVERRIDE if TAP_MODE_OVERRIDE != '' else None
        print(f"🔧 TAP_MODE env override: {tap_mode!r}")

    first_song = target_song if target_song and target_song in audio_files else audio_files[0]
    if target_song and target_song not in audio_files:
        print(f"⚠️  '{target_song}' not found, using '{first_song}'")

    audio_path = os.path.join(audio_folder_abs, first_song)
    print(f"🎵 Song: {first_song}  |  Max duration: {MAX_DURATION}s\n")

    existing = {}
    if os.path.exists(output_json_abs):
        with open(output_json_abs) as f:
            existing = json.load(f)

    # Delete stale analyze_result.json so the backend is forced to serve fresh results.
    analyze_result_path = os.path.join(project_root, "backend", "uploads", "analyze_result.json")
    if os.path.exists(analyze_result_path):
        os.remove(analyze_result_path)
        print(f"🗑️  Cleared stale analyze_result.json")

    try:
        analysis = analyze_audio_advanced(
            audio_path,
            density=density,
            aggressiveness=aggressiveness,
            max_duration=MAX_DURATION,
            focus_bass=focus_bass,
            focus_vocals=focus_vocals,
            focus_repetitions=focus_repetitions,
            sync_to_grid=sync_to_grid,
            tap_mode=tap_mode,
        )

        results = {**existing, first_song: analysis}
        with open(output_json_abs, 'w') as f:
            json.dump(results, f, indent=2)

        # Update options.json song_filename
        if os.path.exists(options_file):
            try:
                with open(options_file) as f:
                    opts = json.load(f)
                opts['song_filename'] = first_song
                with open(options_file, 'w') as f:
                    json.dump(opts, f, indent=2)
            except Exception:
                pass

        data = results[first_song]
        print(f"{'='*60}")
        print(f"✅ Saved to '{OUTPUT_JSON}'")
        print(f"   BPM: {data['bpm']:.1f}  Duration: {data['duration']:.2f}s  Cuts: {len(data['cut_points'])}")
        print(f"{'='*60}\n")
        for i, p in enumerate(data['cut_points'][:15], 1):
            print(f"  {i:2d}. {p['timestamp']:6.2f}s  {p['type']:20s}  score: {p['score']}")
        if len(data['cut_points']) > 15:
            print(f"  ... and {len(data['cut_points']) - 15} more")
        print()

    except Exception as e:
        print(f"❌ Error: {e}\n")
        import traceback; traceback.print_exc()


if __name__ == "__main__":
    main()