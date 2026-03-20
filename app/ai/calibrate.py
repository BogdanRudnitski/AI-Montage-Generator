"""
calibrate.py — Fit analyze.py parameters directly to your manual taps.

Usage:
    python calibrate.py <song_filename> [--reset]

Fully self-contained: generates its own candidate pool fresh from the audio
via generate_all_candidates() — no dependency on a prior analyze run.
"""

import os, sys, json
import numpy as np
from collections import defaultdict

SCRIPT_DIR       = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT     = os.path.dirname(SCRIPT_DIR)
TAPS_FOLDER      = os.path.join(PROJECT_ROOT, "backend", "uploads", "taps")
AUDIO_FOLDER     = os.path.join(SCRIPT_DIR, "../backend/uploads/songs")
ANALYSIS_JSON    = os.path.join(SCRIPT_DIR, "audio_analysis.json")
CALIBRATION_JSON = os.path.join(SCRIPT_DIR, "calibration.json")

MATCH_WINDOW = 0.25
WINDOW_SIZE  = 4.0


def load_json(path):
    with open(path) as f:
        return json.load(f)

def save_json(path, data):
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)
    print(f"💾 Saved → {os.path.relpath(path, SCRIPT_DIR)}")


def get_candidates(song_filename, song_key, max_duration, song_start_sec,
                   focus_bass, focus_vocals, focus_repetitions):
    """Always generate a fresh candidate pool from audio."""
    print("🎛️  Running stem separation for calibration (this takes a minute)...")

    # Import generate_all_candidates from analyze.py (same directory as this file)
    import importlib.util
    analyze_path = os.path.join(SCRIPT_DIR, "analyze.py")
    spec = importlib.util.spec_from_file_location("analyze", analyze_path)
    analyze_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(analyze_mod)
    generate_all_candidates = analyze_mod.generate_all_candidates

    audio_folder = os.path.join(SCRIPT_DIR, AUDIO_FOLDER)
    audio_path   = os.path.join(audio_folder, song_filename)
    if not os.path.exists(audio_path):
        for f in os.listdir(audio_folder):
            if os.path.splitext(f)[0] == song_key:
                audio_path = os.path.join(audio_folder, f)
                break

    return generate_all_candidates(
        audio_path, max_duration=max_duration, song_start_sec=song_start_sec,
        focus_bass=focus_bass, focus_vocals=focus_vocals,
        focus_repetitions=focus_repetitions,
    )


def build_density_profile(tap_times, duration, global_min_dist):
    sorted_taps = sorted(tap_times)
    n_windows   = max(1, int(np.ceil(duration / WINDOW_SIZE)))
    profile     = []
    for i in range(n_windows):
        start    = i * WINDOW_SIZE
        end      = min((i + 1) * WINDOW_SIZE, duration)
        taps_in  = [t for t in sorted_taps if start <= t < end]
        if len(taps_in) >= 2:
            gaps  = [taps_in[j+1] - taps_in[j] for j in range(len(taps_in)-1)]
            min_d = round(max(0.06, float(np.percentile(gaps, 10)) * 0.8), 3)
        elif len(taps_in) == 1:
            min_d = round(min(global_min_dist, WINDOW_SIZE / 2), 3)
        else:
            min_d = global_min_dist
        profile.append({'start': round(start, 3), 'end': round(end, 3),
                        'target_cuts': len(taps_in), 'min_distance': min_d})
    return profile


def calibrate_song(all_candidates, duration, tap_times):
    sorted_taps = sorted(tap_times)

    # Match taps to nearest candidate
    used = set()
    tap_hits, tap_misses = [], []
    for tap in sorted_taps:
        best_d, best_c, best_i = float('inf'), None, -1
        for i, c in enumerate(all_candidates):
            if i in used:
                continue
            d = abs(tap - c['timestamp'])
            if d < best_d:
                best_d, best_c, best_i = d, c, i
        if best_d <= MATCH_WINDOW:
            tap_hits.append((tap, best_c, best_c.get('kept', False)))
            used.add(best_i)
        else:
            tap_misses.append(tap)

    hit_scores  = [c['score'] for _, c, _ in tap_hits]
    kept_hits   = [(t, c) for t, c, kept in tap_hits if kept]
    missed_hits = [(t, c) for t, c, kept in tap_hits if not kept]

    # Threshold
    threshold = max(10.0, round(float(np.percentile(hit_scores, 10)) - 5, 1)) if hit_scores else 30.0

    # Global min_distance
    gaps    = [sorted_taps[i+1] - sorted_taps[i] for i in range(len(sorted_taps)-1)]
    p10_gap = float(np.percentile(gaps, 10)) if gaps else 0.4
    global_min_dist = round(max(0.06, p10_gap * 0.8), 2)

    # Density profile
    density_profile = build_density_profile(sorted_taps, duration, global_min_dist)

    print(f"\n  Taps: {len(sorted_taps)}  hit: {len(tap_hits)}  no-candidate: {len(tap_misses)}")
    print(f"  Tapped+kept: {len(kept_hits)}  Tapped+dismissed: {len(missed_hits)}")
    print(f"  Threshold → {threshold}  Global min_dist → {global_min_dist}s")
    print(f"\n  Density profile ({len(density_profile)} windows):")
    for w in density_profile:
        print(f"    {w['start']:5.1f}–{w['end']:5.1f}s  taps={w['target_cuts']:2d}  min_dist={w['min_distance']}s")

    # Type bonuses
    type_dismissed = defaultdict(list)
    type_kept      = defaultdict(list)
    type_fp        = defaultdict(int)
    for _, c in missed_hits:
        type_dismissed[c['type']].append(c['score'])
    for _, c in kept_hits:
        type_kept[c['type']].append(c['score'])
    kept_ts = {c['timestamp'] for _, c in kept_hits}
    for c in all_candidates:
        if c.get('kept') and c['timestamp'] not in kept_ts:
            if not any(abs(tap - c['timestamp']) <= MATCH_WINDOW for tap in sorted_taps):
                type_fp[c['type']] += 1

    all_types    = set(list(type_dismissed) + list(type_kept) + list(type_fp))
    type_bonuses = {}
    print(f"\n  Per-type bonuses:")
    for t in sorted(all_types):
        dismissed, kept, fp = type_dismissed[t], type_kept[t], type_fp[t]
        bonus = 0
        if dismissed:
            bonus += int(np.clip(threshold - float(np.median(dismissed)) + 10, 0, 60))
        if fp > 2 and not kept:
            bonus -= min(25, fp * 5)
        if kept and not dismissed:
            bonus += 5
        type_bonuses[t] = int(np.clip(bonus, -30, 60))
        print(f"    {t:<22} dismissed={len(dismissed):2d} kept={len(kept):2d} fp={fp:2d}  bonus={type_bonuses[t]:+d}")

    return {
        'type_bonuses':    type_bonuses,
        'min_distance':    global_min_dist,
        'score_threshold': threshold,
        'density_profile': density_profile,
        'stats': {
            'taps':             len(sorted_taps),
            'tapped_kept':      len(kept_hits),
            'tapped_dismissed': len(missed_hits),
            'no_candidate':     len(tap_misses),
            'p10_gap':          round(p10_gap, 3),
            'avg_gap':          round(float(np.mean(gaps)), 3) if gaps else 0,
        },
    }


def merge_calibration(existing, song_key, new_data):
    songs = existing.get('songs', {})
    songs[song_key] = new_data
    existing['songs'] = songs
    all_bonuses = defaultdict(list)
    for s in songs.values():
        for t, b in s.get('type_bonuses', {}).items():
            all_bonuses[t].append(b)
    existing['type_bonuses']     = {t: round(float(np.mean(v)), 1) for t, v in all_bonuses.items()}
    existing['min_distance']     = round(float(np.min([s.get('min_distance', 0.4) for s in songs.values()])), 2)
    existing['score_threshold']  = round(float(np.percentile([s.get('score_threshold', 35) for s in songs.values()], 25)), 1)
    existing['songs_calibrated'] = len(songs)
    return existing


def main():
    args  = sys.argv[1:]
    reset = '--reset' in args
    args  = [a for a in args if a != '--reset']

    if not args:
        print("Usage: python calibrate.py <song_filename> [--reset]")
        sys.exit(1)

    song_filename = args[0]
    song_key      = os.path.splitext(song_filename)[0]

    taps_path = os.path.join(TAPS_FOLDER, f"{song_key}.json")
    if not os.path.exists(taps_path):
        print(f"❌ Tap file not found: {taps_path}")
        sys.exit(1)
    tap_data  = load_json(taps_path)
    tap_times_abs = [float(c['timestamp']) for c in tap_data.get('manual_cuts', [])]
    if not tap_times_abs:
        print("❌ No manual_cuts in tap file.")
        sys.exit(1)

    # Read options for max_duration / song_start_sec / focus flags
    options_file = os.path.join(PROJECT_ROOT, "backend", "uploads", "options.json")
    max_duration = int(os.environ.get('MAX_DURATION', '60'))
    song_start_sec    = 0.0
    focus_bass        = True
    focus_vocals      = True
    focus_repetitions = True
    if os.path.exists(options_file):
        try:
            opts = load_json(options_file)
            song_start_sec    = float(opts.get('song_start_sec', 0) or 0)
            focus_bass        = opts.get('focus_bass', True)
            focus_vocals      = opts.get('focus_vocals', True)
            focus_repetitions = opts.get('focus_repetitions', True)
        except Exception:
            pass

    try:
        if os.environ.get("SONG_START_SEC") is not None and str(os.environ.get("SONG_START_SEC", "")).strip() != "":
            song_start_sec = max(0.0, float(os.environ["SONG_START_SEC"]))
    except (TypeError, ValueError):
        pass

    # Taps are absolute file time; candidate timestamps are relative to the analysis window.
    start = max(0.0, float(song_start_sec or 0.0))
    tap_times = []
    for t in sorted(tap_times_abs):
        if t < start - 1e-6:
            continue
        rel = t - start
        if rel > float(max_duration) + 1e-6:
            continue
        tap_times.append(rel)
    if not tap_times:
        print("❌ No taps fall inside the selected song range (song_start_sec / max_duration).")
        sys.exit(1)

    print(f"\n{'='*60}\n🎯 Calibrating: {song_filename}\n{'='*60}")

    all_candidates, duration = get_candidates(
        song_filename, song_key, max_duration, song_start_sec,
        focus_bass, focus_vocals, focus_repetitions,
    )

    song_cal = calibrate_song(all_candidates, duration, tap_times)
    existing = {} if (reset or not os.path.exists(CALIBRATION_JSON)) else load_json(CALIBRATION_JSON)
    final    = merge_calibration(existing, song_key, song_cal)
    save_json(CALIBRATION_JSON, final)

    print(f"\n{'='*60}")
    print(f"✅ Done  ({final['songs_calibrated']} song(s))")
    print(f"   threshold    : {final['score_threshold']}")
    print(f"   min_distance : {final['min_distance']}s")
    print(f"   type_bonuses : {final['type_bonuses']}")
    print(f"\n👉 Re-run analyze.py with tap_mode='calibrate' to apply.\n")


if __name__ == "__main__":
    main()