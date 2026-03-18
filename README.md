# AI-Powered Video Montage Generator

An AI-powered mobile app that takes your uploaded videos + a soundtrack, analyzes the audio, and exports an edited "montage" video for sharing.

This repo includes:

- `app/clipgsm`: Expo (React Native) frontend
- `app/backend`: FastAPI backend (uploads, analysis, export)
- `app/ai`: Python scripts used by the backend to compute segments and render the final video

## What you need

### System dependencies

- `ffmpeg` and `ffprobe` installed and available on your `PATH`
  - macOS: `brew install ffmpeg`

### Developer dependencies

- Node.js + npm (for the Expo frontend)
- Python 3 (for backend + AI scripts)
- A working simulator/device for Expo

## Setup

From the repo root (`codejam15/`):

### 1) Install Python dependencies (backend)

```bash
cd app/backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 2) Install Python dependencies (AI scripts)

The backend runs the AI scripts using a dedicated venv at `app/ai/venv/` (this is required; the backend checks that the python executable exists).

```bash
cd app/ai
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 3) Install frontend dependencies

```bash
cd app/clipgsm
npm install
```

## Configuration (frontend -> backend URL)

The Expo app uses `EXPO_PUBLIC_SERVER_URL` (see `app/clipgsm/config.ts`).

Create `app/clipgsm/.env`:

```bash
EXPO_PUBLIC_SERVER_URL=http://localhost:8000
```

If you run on a physical phone (not just simulator), replace `localhost` with your machine's LAN IP (same Wi-Fi).

## Run locally

### Terminal 1: start the backend

```bash
cd app/backend
source venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000
```

### Terminal 2: start the app

```bash
cd app/clipgsm
npx expo start
```

For iOS specifically:

```bash
npm run ios
```

## Notes / troubleshooting

- Uploads and exports are written under `app/backend/uploads/*`.
- Export will fail if `ffmpeg` / `ffprobe` are missing or not in `PATH`.
- If you use a phone and uploads fail, double-check `EXPO_PUBLIC_SERVER_URL` points to an IP + port reachable from the phone.