import json
import numpy as np
from scipy.signal import find_peaks

# Load JSON predictions
with open("audio_analysis.json", "r") as f:
    predictions = json.load(f)

# Convert nested JSON to 2D numpy array (frames x features)
predictions = np.array(predictions)
if predictions.ndim > 2:
    predictions = predictions.reshape(predictions.shape[0], -1)

# Compute frame energy
energy = np.sum(predictions, axis=1)

# Smooth energy with a simple moving average
window_size = 5
smoothed_energy = np.convolve(energy, np.ones(window_size)/window_size, mode='same')

# Track info
frame_count = len(energy)
track_length_seconds = 119
frame_duration = track_length_seconds / frame_count  # seconds per frame

# Detect peaks
threshold = smoothed_energy.mean() + 1.5 * smoothed_energy.std()
distance_frames = max(1, int(0.2 / frame_duration))  # ensure at least 1
peaks, _ = find_peaks(smoothed_energy, height=threshold, distance=distance_frames)

# Convert frame indices to seconds
beat_times = [round(p * frame_duration, 2) for p in peaks]

print("Detected beat drops (seconds):")
for t in beat_times:
    print(f"{t}s")