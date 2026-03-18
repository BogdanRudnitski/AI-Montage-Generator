#!/usr/bin/env python3
"""
Compute segment list from existing audio_analysis.json (no ffmpeg).
Writes backend/uploads/analyze_result.json and backend/uploads/segments.json.
Called by backend after analyze.py so the app can preview and later export.
"""
import json
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
ANALYSIS_JSON = os.path.join(SCRIPT_DIR, "audio_analysis.json")
OPTIONS_FILE = os.path.join(PROJECT_ROOT, "backend", "uploads", "options.json")
UPLOADS_DIR = os.path.join(PROJECT_ROOT, "backend", "uploads")
ANALYZE_RESULT_PATH = os.path.join(UPLOADS_DIR, "analyze_result.json")
SEGMENTS_PATH = os.path.join(UPLOADS_DIR, "segments.json")

# Import clip_maker components (no heavy deps for ClipManager + compute_segments_only)
from clip_maker import ClipManager, compute_segments_only, MAX_DURATION, DEFAULT_MIN_CLIP_DURATION


def main():
    print(f"[TRACE] compute_segments.py: ANALYSIS_JSON={ANALYSIS_JSON}")
    if not os.path.exists(ANALYSIS_JSON):
        print(f"Error: {ANALYSIS_JSON} not found. Run analyze.py first.")
        sys.exit(1)
    with open(ANALYSIS_JSON, "r") as f:
        results = json.load(f)
    if not results:
        print("Error: No analysis results.")
        sys.exit(1)
    songs = list(results.keys())
    print(f"[TRACE] compute_segments.py: audio_analysis.json keys (songs) = {songs}")
    target_song = None
    min_clip_duration = DEFAULT_MIN_CLIP_DURATION
    max_clip_duration = None
    if os.path.exists(OPTIONS_FILE):
        try:
            with open(OPTIONS_FILE, "r") as f:
                opts = json.load(f)
                target_song = opts.get("song_filename")
                min_clip_duration = float(opts.get("minClipDuration", min_clip_duration))
                if opts.get("maxClipDuration") is not None:
                    max_clip_duration = float(opts["maxClipDuration"])
            print(f"[TRACE] compute_segments.py: OPTIONS_FILE={OPTIONS_FILE} opts.song_filename={target_song!r} min_clip={min_clip_duration} max_clip={max_clip_duration}")
        except Exception as e:
            print(f"[TRACE] compute_segments.py: failed to read options: {e}")
    selected_song = target_song if target_song and target_song in songs else songs[0]
    if target_song and target_song not in songs:
        base = target_song.rsplit(".", 1)[0]
        matches = [s for s in songs if s.startswith(base)]
        if matches:
            selected_song = matches[-1]
        print(f"[TRACE] compute_segments.py: target_song not in songs, selected_song={selected_song!r} (matches by base: {matches})")
    else:
        print(f"[TRACE] compute_segments.py: selected_song = {selected_song!r} (using this for cut data)")
    data = results[selected_song]
    cut_points = data.get("cut_points", [])
    duration = float(data.get("duration", 0))
    max_dur = data.get("max_duration") or MAX_DURATION
    duration = min(duration, max_dur) if max_dur else duration
    if not cut_points:
        print("Error: No cut points in analysis.")
        sys.exit(1)
    clips_folder = os.path.join(PROJECT_ROOT, "backend", "uploads", "media")
    if not os.path.isdir(clips_folder):
        print(f"Error: Clips folder not found: {clips_folder}")
        sys.exit(1)
    clip_manager = ClipManager(clips_folder)
    if not clip_manager.clips:
        print("Error: No video clips in uploads/media.")
        sys.exit(1)
    segments = compute_segments_only(
        cut_points, duration, clip_manager, max_duration=max_dur,
        min_clip_duration=min_clip_duration, max_clip_duration=max_clip_duration,
    )
    bpm = float(data.get("bpm", 0))
    analyze_result = {
        "duration": round(duration, 3),
        "max_duration": max_dur,
        "bpm": bpm,
        "cut_points": cut_points,
        "segments": segments,
    }
    os.makedirs(UPLOADS_DIR, exist_ok=True)
    with open(ANALYZE_RESULT_PATH, "w") as f:
        json.dump(analyze_result, f, indent=2)
    with open(SEGMENTS_PATH, "w") as f:
        json.dump(segments, f, indent=2)
    print(f"[TRACE] compute_segments.py: wrote analyze_result/segments for song = {selected_song!r} ({len(segments)} segments, duration={duration}, first_cut={cut_points[0] if cut_points else None})")
    print(f"Wrote {ANALYZE_RESULT_PATH} and {SEGMENTS_PATH} ({len(segments)} segments)")


if __name__ == "__main__":
    main()
