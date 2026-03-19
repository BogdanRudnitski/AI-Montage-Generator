"""
calibrate.py — Learn from manual tap data and write calibration.json.

Usage:
    python calibrate.py <song_filename> [--reset]

    song_filename   e.g. "Ke$ha - Tik Tok.mp3"
    --reset         wipe calibration.json and start fresh

What it does:
    1. Loads the tap JSON for the song from uploads/taps/<song>.json
    2. Loads the AI analysis from audio_analysis.json (must exist — run analyze.py first)
    3. Matches taps to the nearest AI candidate (kept or dismissed) within 200ms
    4. Computes per-type precision / recall → score bonuses
    5. Derives calibrated min_distance and score_threshold from your tap gaps / scores
    6. Writes / merges results into calibration.json (one entry per song, plus global averages)

calibration.json is read automatically by analyze.py when tap_mode='calibrate'.
"""

import os
import sys
import json
import numpy as np
from collections import defaultdict

SCRIPT_DIR      = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT    = os.path.dirname(SCRIPT_DIR)
TAPS_FOLDER     = os.path.join(PROJECT_ROOT, "backend", "uploads", "taps")
ANALYSIS_JSON   = os.path.join(SCRIPT_DIR, "audio_analysis.json")
CALIBRATION_JSON = os.path.join(SCRIPT_DIR, "calibration.json")

MATCH_WINDOW = 0.20   # 200 ms — generous matching window


# ─── I/O ──────────────────────────────────────────────────────────────────────

def load_json(path):
    with open(path) as f:
        return json.load(f)

def save_json(path, data):
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)
    print(f"💾 Saved → {os.path.relpath(path, SCRIPT_DIR)}")


# ─── Matching ─────────────────────────────────────────────────────────────────

def match_taps(tap_times, candidates):
    """
    Greedy nearest-match: each tap claims the closest unmatched candidate ≤ MATCH_WINDOW.
    Returns:
        matched   : [(tap_t, candidate_dict, distance), ...]
        unmatched : [tap_t, ...]  — taps with no nearby candidate
    """
    used     = set()
    matched  = []
    unmatched = []

    for tap in sorted(tap_times):
        best_d, best_c, best_i = float('inf'), None, -1
        for i, c in enumerate(candidates):
            if i in used:
                continue
            d = abs(tap - c['timestamp'])
            if d < best_d:
                best_d, best_c, best_i = d, c, i

        if best_d <= MATCH_WINDOW and best_c is not None:
            matched.append((tap, best_c, best_d))
            used.add(best_i)
        else:
            unmatched.append(tap)

    return matched, unmatched


# ─── Core calibration logic ───────────────────────────────────────────────────

def calibrate_song(song_filename, song_data, tap_times):
    kept      = song_data.get('cut_points', [])
    dismissed = song_data.get('dismissed_cuts', [])   # may be absent in old format
    duration  = song_data.get('duration', 60.0)

    all_candidates = kept + dismissed
    all_candidates.sort(key=lambda x: x['timestamp'])

    matched, fully_missed = match_taps(tap_times, all_candidates)

    # False positives: kept by algo but no tap near them
    false_positives = [
        c for c in kept
        if not any(abs(tap - c['timestamp']) <= MATCH_WINDOW for tap in tap_times)
    ]

    print(f"\n  Manual taps      : {len(tap_times)}")
    print(f"  All candidates   : {len(all_candidates)}  (kept={len(kept)}, dismissed={len(dismissed)})")
    print(f"  Matched correct  : {len(matched)}")
    print(f"  False positives  : {len(false_positives)}")
    print(f"  Fully missed     : {len(fully_missed)}")

    # ── Per-type stats ────────────────────────────────────────────────────────
    type_correct = defaultdict(list)
    type_wrong   = defaultdict(list)
    type_missed  = defaultdict(int)

    for _, c, _ in matched:
        type_correct[c['type']].append(c['score'])
    for c in false_positives:
        type_wrong[c['type']].append(c['score'])
    for t in fully_missed:
        closest = min(dismissed, key=lambda c: abs(c['timestamp'] - t), default=None)
        if closest and abs(closest['timestamp'] - t) <= MATCH_WINDOW * 2:
            type_missed[closest['type']] += 1
        else:
            type_missed['unknown'] += 1

    print("\n  Per-type breakdown:")
    type_bonuses = {}
    all_types = set(list(type_correct) + list(type_wrong) + list(type_missed))
    for t in sorted(all_types):
        nc = len(type_correct[t])
        nw = len(type_wrong[t])
        nm = type_missed[t]
        precision = nc / (nc + nw) if (nc + nw) > 0 else 0.5
        recall    = nc / (nc + nm) if (nc + nm) > 0 else 0.5
        f1        = (2 * precision * recall / (precision + recall)
                     if (precision + recall) > 0 else 0.0)
        bonus     = round((f1 - 0.5) * 30)   # –15 … +15
        type_bonuses[t] = bonus
        print(f"    {t:<22} correct={nc:2d} wrong={nw:2d} missed={nm:2d}  "
              f"P={precision:.2f} R={recall:.2f}  bonus={bonus:+d}")

    # ── Min distance from tap gaps ────────────────────────────────────────────
    sorted_taps = sorted(tap_times)
    gaps = [sorted_taps[i+1] - sorted_taps[i] for i in range(len(sorted_taps)-1)]
    p10  = float(np.percentile(gaps, 10)) if gaps else 0.4
    cal_min_dist = round(max(0.1, p10 * 0.85), 2)

    # ── Score threshold from correct vs wrong ─────────────────────────────────
    correct_scores = [c['score'] for _, c, _ in matched]
    wrong_scores   = [c['score'] for c in false_positives]

    if correct_scores and wrong_scores:
        lo = float(np.percentile(correct_scores, 15))
        hi = float(np.percentile(wrong_scores,   85))
        cal_threshold = round(max(15.0, min(65.0, (lo + hi) / 2)), 1)
    elif correct_scores:
        cal_threshold = round(float(np.percentile(correct_scores, 15)) - 5, 1)
    else:
        cal_threshold = 42.0

    # ── Density profile ───────────────────────────────────────────────────────
    window = 5.0
    n_bins = max(1, int(np.ceil(duration / window)))
    counts = []
    density_profile = []
    for i in range(n_bins):
        s, e  = i * window, (i+1) * window
        count = sum(1 for t in sorted_taps if s <= t < e)
        counts.append(count)
        density_profile.append({'start': s, 'end': e, 'target_cuts': count})

    max_count = max(counts) if counts else 1
    for i, d in enumerate(density_profile):
        d['weight'] = round(counts[i] / max_count, 3) if max_count > 0 else 0.5

    print(f"\n  Calibrated min_distance : {cal_min_dist}s  (p10 gap: {p10:.2f}s)")
    print(f"  Calibrated threshold    : {cal_threshold}")

    return {
        'type_bonuses':    type_bonuses,
        'min_distance':    cal_min_dist,
        'score_threshold': cal_threshold,
        'density_profile': density_profile,
        'stats': {
            'manual_cuts':     len(sorted_taps),
            'matched':         len(matched),
            'false_positives': len(false_positives),
            'fully_missed':    len(fully_missed),
            'p10_gap':         round(p10, 3),
            'avg_gap':         round(float(np.mean(gaps)), 3) if gaps else 0,
        },
    }


def merge_calibration(existing, song_key, new_data):
    """Add/update one song entry and recompute global averages."""
    songs = existing.get('songs', {})
    songs[song_key] = new_data
    existing['songs'] = songs

    # Global type bonuses: average across all songs
    all_bonuses = defaultdict(list)
    for s in songs.values():
        for t, b in s.get('type_bonuses', {}).items():
            all_bonuses[t].append(b)
    existing['type_bonuses'] = {t: round(float(np.mean(v)), 1) for t, v in all_bonuses.items()}

    # Global min_distance: minimum across songs (respect tight cutting style)
    existing['min_distance'] = round(float(np.min([s.get('min_distance', 0.4) for s in songs.values()])), 2)

    # Global threshold: 25th percentile (keep more, let energy profile decide)
    existing['score_threshold'] = round(float(np.percentile(
        [s.get('score_threshold', 42) for s in songs.values()], 25)), 1)

    existing['songs_calibrated'] = len(songs)
    return existing


# ─── CLI ─────────────────────────────────────────────────────────────────────

def main():
    args  = sys.argv[1:]
    reset = '--reset' in args
    args  = [a for a in args if a != '--reset']

    if not args:
        print("Usage: python calibrate.py <song_filename> [--reset]")
        print("       e.g. python calibrate.py \"Ke\\$ha - Tik Tok.mp3\"")
        sys.exit(1)

    song_filename = args[0]
    song_key      = os.path.splitext(song_filename)[0]

    # ── Load taps ─────────────────────────────────────────────────────────────
    taps_path = os.path.join(TAPS_FOLDER, f"{song_key}.json")
    if not os.path.exists(taps_path):
        print(f"❌ Tap file not found: {taps_path}")
        print(f"   Export taps from tap_cutter and save as uploads/taps/{song_key}.json")
        sys.exit(1)

    tap_data  = load_json(taps_path)
    tap_times = [float(c['timestamp']) for c in tap_data.get('manual_cuts', [])]
    if not tap_times:
        print("❌ No manual_cuts found in tap file.")
        sys.exit(1)

    # ── Load analysis ─────────────────────────────────────────────────────────
    if not os.path.exists(ANALYSIS_JSON):
        print(f"❌ {ANALYSIS_JSON} not found — run analyze.py first.")
        sys.exit(1)

    analysis = load_json(ANALYSIS_JSON)
    song_data = analysis.get(song_filename) or analysis.get(song_key)
    if song_data is None:
        available = list(analysis.keys())
        print(f"❌ '{song_filename}' not in audio_analysis.json.")
        print(f"   Available keys: {available}")
        sys.exit(1)

    print(f"\n{'='*60}")
    print(f"🎯 Calibrating: {song_filename}")
    print(f"{'='*60}")

    # ── Run calibration ───────────────────────────────────────────────────────
    song_cal = calibrate_song(song_filename, song_data, tap_times)

    # ── Merge & save ──────────────────────────────────────────────────────────
    if reset or not os.path.exists(CALIBRATION_JSON):
        existing = {}
    else:
        existing = load_json(CALIBRATION_JSON)

    final = merge_calibration(existing, song_key, song_cal)
    save_json(CALIBRATION_JSON, final)

    print(f"\n{'='*60}")
    print(f"✅ Calibration complete  ({final['songs_calibrated']} song(s) in database)")
    print(f"   Global min_distance  : {final['min_distance']}s")
    print(f"   Global threshold     : {final['score_threshold']}")
    print(f"   Type bonuses         : {final['type_bonuses']}")
    print(f"\n👉 Re-run analyze.py with tap_mode='calibrate' to apply.\n")


if __name__ == "__main__":
    main()
