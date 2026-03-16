/**
 * Backend server URL. Not committed – set in .env (see .env.example).
 * Use your machine's local IP when running the app on a device/simulator.
 * Backend: cd app/backend && source venv/bin/activate && uvicorn main:app --host 0.0.0.0 --port 8000
 */
export const SERVER_URL =
  process.env.EXPO_PUBLIC_SERVER_URL ?? "http://localhost:8000";
