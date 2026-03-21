# AI-Powered Video Montage Generator

An AI-powered mobile app that takes your uploaded videos + a soundtrack, analyzes the audio, and exports an edited montage video for sharing.

This repo includes:

- `app/clipgsm` — Expo (React Native) frontend
- `app/backend` — FastAPI backend (uploads, analysis, export)
- `app/ai` — Python scripts used by the backend to compute segments and render the final video

---

## Requirements

- **ffmpeg** and **ffprobe** on your `PATH` — `brew install ffmpeg` on macOS
- **Node.js + npm** for the frontend
- **Python 3** for the backend and AI scripts
- A simulator or physical device for Expo

---

## Quick start

### 1. Install dependencies

```bash
# Frontend
cd app/clipgsm
npm install

# Backend
cd app/backend
pip3 install -r requirements.txt

# AI scripts
cd app/ai
pip3 install -r requirements.txt
```

### 2. Configure the backend URL

Create `app/clipgsm/.env`:

```bash
EXPO_PUBLIC_SERVER_URL=http://localhost:8000
```

> Running on a physical phone? Replace `localhost` with your machine's LAN IP (both devices must be on the same Wi-Fi).

### 3. Run

**Terminal 1 — backend:**

```bash
cd app/backend
python3 -m uvicorn main:app --host 0.0.0.0 --port 8000
```

**Terminal 2 — app:**

```bash
cd app/clipgsm
npx expo start
# or for iOS specifically:
npm run ios
```

---

## More control: isolated environments with venv

If you want to keep dependencies isolated or avoid conflicts with other Python projects, use virtual environments instead of installing globally.

### Backend venv

```bash
cd app/backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Then run the backend with the venv active:

```bash
source venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000
```

### AI scripts venv

The backend can also run AI scripts using a dedicated venv at `app/ai/venv/`. If this venv exists, the backend will use it automatically.

```bash
cd app/ai
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

---

## Troubleshooting

- Uploads and exports are written to `app/backend/uploads/`.
- Export will fail if `ffmpeg` / `ffprobe` are missing or not in `PATH`.
- If uploads fail from a physical device, double-check `EXPO_PUBLIC_SERVER_URL` points to a LAN IP reachable from the phone.