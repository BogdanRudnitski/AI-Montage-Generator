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
# If TAP_MODE is present in the environment (including ""), it wins over options.json.
# If TAP_MODE is absent (e.g. CLI), options.json tap_mode is used.

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

def taps_to_cut_points(tap_timestamps, max_duration, song_start_sec=0.0):
    """Return tap timestamps as cut_points in the standard output schema.

    Tap files store absolute times in the full song. Cut points in the analyze
    output are relative to the selected window [song_start_sec, song_start_sec + max_duration).
    """
    start = max(0.0, float(song_start_sec or 0.0))
    window = float(max_duration) if max_duration is not None else float("inf")
    out = []
    for t in sorted(tap_timestamps):
        t = float(t)
        if t < start - 1e-6:
            continue
        rel = t - start
        if rel < -1e-6 or rel > window + 1e-6:
            continue
        out.append(
            {
                "timestamp": float(rel),
                "score": 100,
                "type": "manual_tap",
                "strength": 1.0,
                "on_grid": False,
                "description": "Manual Tap",
                "repetition_gap": None,
            }
        )
    return out

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

    density_profile = cal.get('density_profile', [])
    return result, cal.get('type_bonuses', {}), density_profile

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

    # Band-specific tuning: low band (kick) gets more sensitive settings
    band_config = {
        'low':  {'threshold_sigma': 0.1, 'distance_s': 0.15, 'prominence': 0.02},  # very sensitive
        'mid':  {'threshold_sigma': 0.4, 'distance_s': 0.10, 'prominence': 0.05},
        'high': {'threshold_sigma': 0.4, 'distance_s': 0.05, 'prominence': 0.05},
    }

    onsets = {}
    for band_name, (lo, hi) in bands.items():
        cfg      = band_config[band_name]
        filtered = bandpass_filter(audio, lo, hi, sr)

        # Use onset strength (flux) instead of raw RMS for low band —
        # much better at catching transient attacks vs sustained energy
        if band_name == 'low':
            env = compute_onset_strength(filtered, sr, hop_length)
        else:
            env = librosa.feature.rms(y=filtered, frame_length=2048, hop_length=hop_length)[0]
        env = gaussian_filter1d(env, sigma=1 if band_name == 'low' else 2)

        if np.max(env) > 0:
            env = env / np.max(env)

        threshold = np.mean(env) + cfg['threshold_sigma'] * np.std(env)
        peaks, props = find_peaks(env, height=threshold,
                                  distance=int(cfg['distance_s'] * sr / hop_length),
                                  prominence=cfg['prominence'])
        onsets[band_name] = {
            'times':     times[peaks] if len(peaks) < len(times) else times[peaks[:len(times)-1]],
            'strengths': props['peak_heights'],
            'envelope':  env,
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

    onset_max = np.max(onset) if np.max(onset) > 0 else 1.0
    onset_n   = onset / onset_max
    times     = librosa.frames_to_time(np.arange(len(onset_n)), sr=sr, hop_length=hop_length)

    # Adaptive local threshold: each frame is judged against its local neighbourhood
    # (±2s window) so quiet-intro peaks aren't suppressed by the loud section's mean.
    window_frames = int(2.0 * sr / hop_length)
    local_thresh  = np.zeros_like(onset_n)
    for i in range(len(onset_n)):
        lo = max(0, i - window_frames)
        hi = min(len(onset_n), i + window_frames)
        region = onset_n[lo:hi]
        local_thresh[i] = np.mean(region) + 1.2 * np.std(region)

    # A peak must exceed its local threshold AND have meaningful prominence
    peaks, props = find_peaks(onset_n, height=local_thresh,
                              distance=int(0.25 * sr / hop_length),
                              prominence=np.std(onset_n) * 0.4)
    return times[peaks], props['peak_heights']

def detect_bass_drops(bass_audio, sr, hop_length=512):
    """
    Detects bass events in three ways:
    1. Energy increases (classic bass drop / re-entry)
    2. RMS peaks (strong sustained bass moments)
    3. Onset transients (note attacks in bass line)
    Returns normalized intensity in [0, 1] for all events.
    """
    filtered = bandpass_filter(bass_audio, 20, 250, sr)
    rms      = gaussian_filter1d(
                   librosa.feature.rms(y=filtered, frame_length=2048, hop_length=hop_length)[0],
                   sigma=3)
    times    = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop_length)
    drops    = []

    rms_ref = np.percentile(rms, 95) if np.max(rms) > 0 else 1.0
    if rms_ref < 1e-9:
        rms_ref = np.max(rms) if np.max(rms) > 0 else 1.0
    rms_n = np.clip(rms / rms_ref, 0.0, 1.0)

    seen = set()

    def _add(time_val, intensity_norm, kind):
        key = round(time_val, 1)
        if key not in seen:
            seen.add(key)
            drops.append({'time': time_val,
                          'intensity': float(np.clip(intensity_norm, 0.0, 1.0)),
                          'type': kind})

    # 1. Energy increases (bass re-entry / drops)
    window = int(0.5 * sr / hop_length)
    for i in range(window, len(rms) - window, window // 4):
        before = np.mean(rms[i-window:i])
        after  = np.mean(rms[i:i+window])
        if after > before * 1.3 and before > 0.0005:
            norm = np.clip((after / max(before, 1e-9) - 1.0) / 3.0, 0.0, 1.0)
            _add(times[i], norm, 'increase')

    # 2. RMS peaks — threshold relative to active-bass frames only
    active_frames = rms_n[rms_n > 0.1]
    if len(active_frames) > 10:
        peak_threshold = np.percentile(active_frames, 40)
    else:
        peak_threshold = 0.15
    peaks, props = find_peaks(rms_n, height=peak_threshold,
                              distance=int(0.3 * sr / hop_length), prominence=0.05)
    for p in peaks:
        _add(times[p], rms_n[p], 'peak')

    # 3. Bass onset transients (note attacks)
    onset_env = compute_onset_strength(filtered, sr, hop_length)
    onset_ref = np.percentile(onset_env, 95) if np.max(onset_env) > 0 else 1.0
    if onset_ref < 1e-9:
        onset_ref = np.max(onset_env) if np.max(onset_env) > 0 else 1.0
    onset_n   = np.clip(onset_env / onset_ref, 0.0, 1.0)
    threshold = np.mean(onset_n) + 0.4 * np.std(onset_n)
    o_peaks, o_props = find_peaks(onset_n, height=threshold,
                                  distance=int(0.1 * sr / hop_length),
                                  prominence=0.05)
    for p in o_peaks:
        _add(times[p], onset_n[p], 'onset')

    return drops


def compute_bass_activity(bass_audio, sr, hop_length=512):
    """Returns a normalized RMS envelope for bass — used to boost scores when bass is active."""
    filtered = bandpass_filter(bass_audio, 20, 250, sr)
    rms      = gaussian_filter1d(
                   librosa.feature.rms(y=filtered, frame_length=2048, hop_length=hop_length)[0],
                   sigma=5)
    rms_ref  = np.percentile(rms, 95) if np.max(rms) > 0 else 1.0
    if rms_ref < 1e-9:
        rms_ref = np.max(rms) if np.max(rms) > 0 else 1.0
    times    = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop_length)
    return times, np.clip(rms / rms_ref, 0.0, 1.0)


def compute_drum_low_prominence(drum_audio, sr, hop_length=512):
    """
    Returns a single float [0, 1] representing how prominent/dominant
    the kick drum (low band) is in this track overall.
    High = kick is loud, consistent, and regular (like a 4-on-the-floor beat).
    """
    filtered = bandpass_filter(drum_audio, 20, 250, sr)
    rms      = gaussian_filter1d(
                   librosa.feature.rms(y=filtered, frame_length=2048, hop_length=hop_length)[0],
                   sigma=3)
    rms_max  = np.max(rms) if np.max(rms) > 0 else 1.0
    rms_n    = rms / rms_max

    min_lag = int(0.3 * sr / hop_length)
    max_lag = int(0.7 * sr / hop_length)
    if len(rms_n) > max_lag * 2:
        acorr = np.correlate(rms_n, rms_n, mode='full')
        acorr = acorr[len(acorr)//2:]
        acorr /= acorr[0] if acorr[0] > 0 else 1.0
        regularity = float(np.max(acorr[min_lag:max_lag]))
    else:
        regularity = 0.0

    energy     = float(np.mean(rms_n))
    prominence = np.clip(0.5 * regularity + 0.5 * energy * 3.0, 0.0, 1.0)
    return float(prominence)


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
                    type_bonuses=None, bass_activity_at_time=0.0, focus_bass=True,
                    drum_low_prominence=0.0):
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
        'bass_drop':        30,
        'drum_low':         20,
        'drum_mid':          8,
        'drum_high':         5,
        'vocal_transient':   8,
        'vocal_repetition': 18,
        'pattern_change':   12,
    }
    score += type_base.get(event['type'], 0)
    if event['type'] == 'vocal_repetition' and event.get('gap', 1.0) < 0.5:
        score += 10

    # ── Context-aware boosting ────────────────────────────────────────────────
    is_drum_low = event['type'] == 'drum_low'
    is_vocal    = event['type'] in ('vocal_transient', 'vocal_repetition')
    is_bass     = event['type'] == 'bass_drop'
    bass_active = bass_activity_at_time

    # Determine what's dominant right now
    beat_dominant = drum_low_prominence > 0.4
    bass_dominant = focus_bass and bass_active > 0.35
    quiet_section = bass_active < 0.15 and drum_low_prominence < 0.35

    if quiet_section:
        # Nothing driving rhythm — vocals are the primary signal
        if is_vocal:
            score += 35  # strong boost so they clear threshold easily
        elif is_drum_low or is_bass:
            score += 10  # still show weak rhythmic hints if present

    elif bass_dominant and not beat_dominant:
        # Bass is the driver
        if is_bass:
            score += bass_active * 35
        elif is_drum_low:
            pass  # kick coexists with bass, no penalty
        elif is_vocal:
            score -= bass_active * 10  # light suppression only
        else:
            score -= bass_active * 30  # suppress pattern_change etc

    elif beat_dominant and not bass_dominant:
        # Kick is the driver
        if is_drum_low:
            score += drum_low_prominence * 30
        elif is_bass:
            pass  # bass coexists with kick
        elif is_vocal:
            pass  # vocals still allowed alongside kick
        else:
            score -= drum_low_prominence * 15

    elif bass_dominant and beat_dominant:
        # Both driving — bass + kick dominate, vocals suppressed
        if is_bass:
            score += bass_active * 35
        elif is_drum_low:
            score += drum_low_prominence * 20
        elif is_vocal:
            score -= 15  # vocals clearly secondary when beat + bass both pumping
        else:
            score -= 25

    # Calibration type bonus
    if type_bonuses:
        score += type_bonuses.get(event['type'], 0)

    return min(int(score), 100)

def generate_all_candidates(audio_path, max_duration=None, song_start_sec=0.0,
                            focus_bass=True, focus_vocals=True, focus_repetitions=True):
    """
    Run stem separation + detection and return a flat list of all scored candidates.
    Used by both analyze_audio_advanced and calibrate.py (as fallback when
    all_candidates isn't already in audio_analysis.json).
    Each entry: {timestamp, score, type, strength, kept=False}
    'kept' is always False here — caller decides threshold.
    """
    import torch
    from demucs import pretrained
    from demucs.apply import apply_model

    song_start_sec = max(0.0, float(song_start_sec or 0.0))
    full_duration  = float(librosa.get_duration(path=audio_path))
    song_start_sec = min(song_start_sec, max(0.0, full_duration - 0.01))
    load_duration  = float(max_duration) if (max_duration and max_duration > 0) else None

    wav_np, sr = librosa.load(audio_path, sr=22050, mono=False,
                              offset=song_start_sec, duration=load_duration)
    if wav_np.ndim == 2 and wav_np.shape[1] <= 4 < wav_np.shape[0]:
        wav_np = np.ascontiguousarray(wav_np.T)
    if wav_np.ndim == 1:
        wav_np = np.stack([wav_np, wav_np])
    elif wav_np.shape[0] == 1:
        wav_np = np.vstack([wav_np, wav_np])

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model  = pretrained.get_model('htdemucs')
    model.to(device).eval()
    with torch.no_grad():
        sources = apply_model(model, torch.from_numpy(wav_np).float().unsqueeze(0).to(device), device=device)[0]

    drum_mono  = np.mean(sources[0].cpu().numpy(), axis=0)
    bass_mono  = np.mean(sources[1].cpu().numpy(), axis=0)
    vocal_mono = np.mean(sources[3].cpu().numpy(), axis=0)

    tempo, beat_times, grid_times = estimate_bpm_and_beats(drum_mono, sr)
    drum_onsets, _   = detect_multiband_onsets(drum_mono, sr)
    drum_low_prom    = compute_drum_low_prominence(drum_mono, sr)
    pattern_changes  = detect_drum_pattern_changes(drum_mono, sr)

    vocal_times, vocal_strengths = (detect_vocal_transients(vocal_mono, sr)
                                    if focus_vocals else (np.array([]), np.array([])))
    if focus_vocals and len(vocal_strengths) > 0 and np.max(vocal_strengths) > 0:
        v_ref = np.percentile(vocal_strengths, 95)
        vocal_strengths = np.clip(vocal_strengths / max(v_ref, 1e-9), 0.0, 1.0)

    vocal_reps = detect_vocal_repetitions(vocal_mono, sr) if focus_repetitions else []
    bass_drops = detect_bass_drops(bass_mono, sr) if focus_bass else []
    bass_activity_times, bass_activity_rms = (
        compute_bass_activity(bass_mono, sr) if focus_bass
        else (np.array([0.0]), np.array([0.0]))
    )

    candidates = []
    for band in ['low', 'mid', 'high']:
        strengths = drum_onsets[band]['strengths']
        s_max = np.max(strengths) if len(strengths) > 0 and np.max(strengths) > 0 else 1.0
        for t, s in zip(drum_onsets[band]['times'], strengths):
            candidates.append({'time': t, 'strength': float(s / s_max), 'type': f'drum_{band}', 'multi_band': 0})
    for t, s in zip(vocal_times, vocal_strengths):
        candidates.append({'time': t, 'strength': float(s), 'type': 'vocal_transient', 'multi_band': 0})
    for rep in vocal_reps:
        candidates.append({'time': rep['time'], 'strength': rep['strength'],
                           'type': 'vocal_repetition', 'multi_band': 0, 'gap': rep.get('gap', 0)})
    for drop in bass_drops:
        candidates.append({'time': drop['time'], 'strength': drop['intensity'], 'type': 'bass_drop', 'multi_band': 0})
    for change in pattern_changes:
        candidates.append({'time': change['time'], 'strength': change['distance'], 'type': 'pattern_change', 'multi_band': 0})

    for c in candidates:
        c['multi_band'] = sum(
            1 for band in ['low', 'mid', 'high']
            if np.any(np.abs(drum_onsets[band]['times'] - c['time']) < 0.03)
        ) / 3.0

    bar_length = (60.0 / tempo) * 4 if tempo > 0 else 4.0
    result = []
    for c in candidates:
        bass_at_t = float(np.interp(c['time'], bass_activity_times, bass_activity_rms))
        score = score_cut_point(c, beat_times, grid_times, pattern_changes, bar_length,
                                bass_activity_at_time=bass_at_t, focus_bass=focus_bass,
                                drum_low_prominence=drum_low_prom)
        result.append({
            'timestamp': float(c['time']),
            'score':     int(score),
            'type':      c['type'],
            'strength':  float(c['strength']),
            'kept':      False,
        })
    result.sort(key=lambda x: x['timestamp'])
    return result, float(wav_np.shape[1] / sr)


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
    song_start_sec=0.0,
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

    # ── Load only the selected window [song_start_sec, +max_duration) ────────
    song_start_sec = max(0.0, float(song_start_sec or 0.0))
    full_duration = float(librosa.get_duration(path=audio_path))
    song_start_sec = min(song_start_sec, max(0.0, full_duration - 0.01))
    load_seconds = float(max_duration) if (max_duration and max_duration > 0) else None

    print(f"   Window: start={song_start_sec:.2f}s  (full track {full_duration:.2f}s)\n")

    wav_np, sr = librosa.load(
        audio_path, sr=22050, mono=False, offset=song_start_sec, duration=load_seconds
    )
    if wav_np.ndim == 1:
        wav_np = np.stack([wav_np, wav_np])
    elif wav_np.shape[0] == 1:
        wav_np = np.vstack([wav_np, wav_np])

    duration = float(wav_np.shape[1] / sr)

    print(f"   ⏱️  {duration:.2f}s analyzed (segment 0–{duration:.2f}s maps to file {song_start_sec:.2f}–{song_start_sec + duration:.2f}s)\n")

    # ── VERBATIM TAP MODE ─────────────────────────────────────────────────────
    if tap_mode == 'verbatim':
        taps = load_taps(song_filename)
        if taps is None:
            print("No tap file found — falling back to AI analysis.\n")
            tap_mode = None
        else:
            cut_points = taps_to_cut_points(taps, max_duration or duration, song_start_sec=song_start_sec)
            print(f"Using {len(cut_points)} manual taps verbatim\n")

            # Still get BPM from drums for metadata
            mono = np.mean(wav_np, axis=0)
            onset_env = librosa.onset.onset_strength(y=mono, sr=sr)
            tempo_r, beats = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr)
            tempo      = float(np.atleast_1d(tempo_r)[0])
            beat_times = librosa.frames_to_time(beats, sr=sr).tolist()[:20]

            return _build_result(song_filename, cut_points, [], duration, full_duration,
                                 max_duration, tempo, beat_times, len(taps),
                                 density, aggressiveness, focus_bass, focus_vocals,
                                 focus_repetitions, sync_to_grid, song_start_sec)

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
    drum_low_prominence = compute_drum_low_prominence(drum_mono, sr)
    print(f"   Low: {len(drum_onsets['low']['times'])}  "
          f"Mid: {len(drum_onsets['mid']['times'])}  "
          f"High: {len(drum_onsets['high']['times'])}  "
          f"Kick prominence: {drum_low_prominence:.2f}\n")

    vocal_times, vocal_strengths = (detect_vocal_transients(vocal_mono, sr)
                                    if focus_vocals else (np.array([]), np.array([])))
    if focus_vocals:
        # Normalize to 95th-percentile so quiet-section peaks aren't crushed
        # by one loud section pulling max up
        if len(vocal_strengths) > 0 and np.max(vocal_strengths) > 0:
            v_ref = np.percentile(vocal_strengths, 95)
            if v_ref < 1e-9:
                v_ref = np.max(vocal_strengths)
            vocal_strengths = np.clip(vocal_strengths / v_ref, 0.0, 1.0)
        print(f"🎤 Vocal transients: {len(vocal_times)}\n")

    vocal_reps = detect_vocal_repetitions(vocal_mono, sr) if focus_repetitions else []
    if focus_repetitions:
        print(f"🔁 Vocal repetitions: {len(vocal_reps)}\n")

    bass_drops = detect_bass_drops(bass_mono, sr) if focus_bass else []
    if focus_bass:
        print(f"🎸 Bass events: {len(bass_drops)}\n")

    # Bass activity envelope — used to contextually boost/suppress scores
    bass_activity_times, bass_activity_rms = (
        compute_bass_activity(bass_mono, sr) if focus_bass
        else (np.array([0.0]), np.array([0.0]))
    )

    print("🔄 Detecting drum pattern changes...")
    pattern_changes = detect_drum_pattern_changes(drum_mono, sr)
    print(f"   Found {len(pattern_changes)} pattern changes\n")

    # ── Build candidates ──────────────────────────────────────────────────────
    candidates = []
    for band in ['low', 'mid', 'high']:
        strengths = drum_onsets[band]['strengths']
        s_max = np.max(strengths) if len(strengths) > 0 and np.max(strengths) > 0 else 1.0
        for t, s in zip(drum_onsets[band]['times'], strengths):
            candidates.append({'time': t, 'strength': float(s / s_max),
                                'type': f'drum_{band}', 'multi_band': 0})
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
    type_bonuses    = {}
    density_profile = None
    preset          = dict(DENSITY_PRESETS[density])

    if tap_mode == 'calibrate':
        calibration = load_calibration(script_dir)
        if calibration:
            preset, type_bonuses, density_profile = apply_calibration_to_preset(preset, calibration, song_key)
            print(f"🎯 Calibration loaded — min_dist={preset['min_distance']}  "
                  f"threshold={preset['score_threshold']}  "
                  f"type_bonuses={type_bonuses}  "
                  f"density_windows={len(density_profile) if density_profile else 0}\n")
        else:
            print("⚠️  No calibration.json found — running uncalibrated AI analysis.\n")

    # ── Score & filter ────────────────────────────────────────────────────────
    bar_length         = (60.0 / tempo) * 4 if tempo > 0 else 4.0
    adjusted_threshold = preset['score_threshold'] * (1.0 - aggressiveness * 0.3)

    print(f"✨ Scoring {len(candidates)} candidates (threshold: {adjusted_threshold:.1f})...\n")

    scored = []
    for c in candidates:
        bass_at_t = float(np.interp(c['time'], bass_activity_times, bass_activity_rms))
        score = score_cut_point(c, beat_times, grid_times, pattern_changes,
                                bar_length, type_bonuses,
                                bass_activity_at_time=bass_at_t,
                                focus_bass=focus_bass,
                                drum_low_prominence=drum_low_prominence)
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

    # ── Local-density-aware deduplication ─────────────────────────────────────
    # If calibration has a density_profile, use per-window min_distance.
    # Otherwise fall back to global preset min_distance.
    def local_min_distance(t):
        if not density_profile:
            return preset['min_distance']
        for window in density_profile:
            if window['start'] <= t < window['end']:
                return window['min_distance']
        return preset['min_distance']

    deduped = []
    for c in scored:
        min_d = local_min_distance(c['timestamp'])
        if not deduped or (c['timestamp'] - deduped[-1]['timestamp']) >= min_d:
            deduped.append(c)
        elif c['score'] > deduped[-1]['score']:
            deduped[-1] = c

    max_cuts = preset['max_cuts']
    if density_profile and len(deduped) > 0:
        # Keep up to target_cuts per window, picking highest scores
        filtered = []
        for window in density_profile:
            window_cuts = [c for c in deduped
                           if window['start'] <= c['timestamp'] < window['end']]
            target = window.get('target_cuts', max_cuts)
            if len(window_cuts) > target:
                window_cuts = sorted(window_cuts, key=lambda x: -x['score'])[:target]
                window_cuts.sort(key=lambda x: x['timestamp'])
            filtered.extend(window_cuts)
    elif len(deduped) > max_cuts:
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

    # Save all scored candidates (not just kept ones) so calibrate.py can
    # match taps against the full pool and compute real false positives / misses
    all_scored = []
    for c in candidates:
        bass_at_t = float(np.interp(c['time'], bass_activity_times, bass_activity_rms))
        s = score_cut_point(c, beat_times, grid_times, pattern_changes,
                            bar_length, type_bonuses,
                            bass_activity_at_time=bass_at_t,
                            focus_bass=focus_bass,
                            drum_low_prominence=drum_low_prominence)
        all_scored.append({
            'timestamp': float(c['time']),
            'score':     int(s),
            'type':      c['type'],
            'strength':  float(c['strength']),
            'kept':      s >= adjusted_threshold,
        })
    all_scored.sort(key=lambda x: x['timestamp'])

    return _build_result(song_filename, filtered, all_scored, duration, full_duration,
                         max_duration, tempo,
                         beat_times[:20].tolist() if hasattr(beat_times, 'tolist') else list(beat_times)[:20],
                         len(candidates), density, aggressiveness,
                         focus_bass, focus_vocals, focus_repetitions, sync_to_grid, song_start_sec)


def _build_result(song_filename, cut_points, all_candidates, duration, full_duration, max_duration,
                  tempo, beat_times, total_candidates, density, aggressiveness,
                  focus_bass, focus_vocals, focus_repetitions, sync_to_grid, song_start_sec=0.0):
    return {
        'last_analyzed':    datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        'duration':         float(duration),
        'full_duration':    float(full_duration),
        'max_duration':     max_duration,
        'song_start_sec':   float(song_start_sec or 0.0),
        'bpm':              float(tempo),
        'beat_times':       [float(t) for t in beat_times],
        'total_candidates': total_candidates,
        'cut_points':       cut_points,
        'all_candidates':   all_candidates,   # full scored pool for calibrate.py
        'settings': {
            'density':            density,
            'aggressiveness':     aggressiveness,
            'max_duration':       max_duration,
            'song_start_sec':     float(song_start_sec or 0.0),
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
        print(f"No audio files in '{AUDIO_FOLDER}'\n")
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
    song_start_sec    = 0.0

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
            song_start_sec    = float(opts.get('song_start_sec', 0) or 0)
            print(f"📋 Options loaded  tap_mode={tap_mode}  density={density}  aggressiveness={aggressiveness}")
        except Exception as e:
            print(f"⚠️  options.json error: {e} — using defaults")

    # Backend sets SONG_START_SEC for each /analyze request (authoritative).
    try:
        _env_start = os.environ.get("SONG_START_SEC")
        if _env_start is not None and str(_env_start).strip() != "":
            song_start_sec = max(0.0, float(_env_start))
    except (TypeError, ValueError):
        pass

    # Per-request override beats options.json (backend sets TAP_MODE for every /analyze call).
    if "TAP_MODE" in os.environ:
        raw = os.environ.get("TAP_MODE", "")
        tap_mode = None if raw == "" else (raw if raw in ("verbatim", "calibrate") else None)
        print(f"🔧 TAP_MODE env override: {tap_mode!r}")

    first_song = target_song if target_song and target_song in audio_files else audio_files[0]
    if target_song and target_song not in audio_files:
        print(f"⚠️  '{target_song}' not found, using '{first_song}'")

    audio_path = os.path.join(audio_folder_abs, first_song)
    print(
        f"🎵 Song: {first_song}  |  Max duration: {MAX_DURATION}s  |  song_start_sec: {song_start_sec:.2f}s\n"
    )

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
            song_start_sec=song_start_sec,
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