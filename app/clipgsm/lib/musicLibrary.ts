import * as FileSystem from "expo-file-system/legacy";

/** Persisted manifest path: app document directory. Survives app restarts. */
const LIBRARY_MANIFEST_PATH = `${FileSystem.documentDirectory ?? ""}clipgsm_music_library.json`;
/** Directory where audio files and cover art are stored. Same as manifest: app document directory. */
export const MUSIC_DIR = `${FileSystem.documentDirectory ?? ""}clipgsm_music/`;

export interface SavedTrack {
  id: string;
  name: string;
  /** Optional artist/singer. Persisted. */
  artist?: string;
  uri: string;
  /** Optional cover art URI (file in MUSIC_DIR, e.g. {id}_art.jpg). Persisted. */
  artUri?: string;
}

async function ensureMusicDir(): Promise<void> {
  const dir = FileSystem.documentDirectory + "clipgsm_music";
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
}

async function loadManifest(): Promise<SavedTrack[]> {
  try {
    const info = await FileSystem.getInfoAsync(LIBRARY_MANIFEST_PATH);
    if (!info.exists) return [];
    const raw = await FileSystem.readAsStringAsync(LIBRARY_MANIFEST_PATH);
    const parsed = JSON.parse(raw) as SavedTrack[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveManifest(tracks: SavedTrack[]): Promise<void> {
  await FileSystem.writeAsStringAsync(LIBRARY_MANIFEST_PATH, JSON.stringify(tracks));
}

/** Get all saved tracks from the library. */
export async function getSavedTracks(): Promise<SavedTrack[]> {
  return loadManifest();
}

/**
 * Copy audio (and optional cover art) to app storage and add to library.
 * Files are persisted at: documentDirectory/clipgsm_music/{id}.{ext} and optionally {id}_art.{ext}.
 * artSourceUri can be a file URI or a data: URL (base64 image).
 */
export async function addTrackToLibrary(
  sourceUri: string,
  name: string,
  artSourceUri?: string,
  artist?: string
): Promise<SavedTrack> {
  await ensureMusicDir();
  const id = `track_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const ext = sourceUri.split(".").pop()?.toLowerCase() || "mp3";
  const destUri = `${MUSIC_DIR}${id}.${ext}`;
  await FileSystem.copyAsync({ from: sourceUri, to: destUri });
  let artUri: string | undefined;
  if (artSourceUri) {
    const artExt = artSourceUri.startsWith("data:")
      ? "jpg"
      : (artSourceUri.split(".").pop()?.toLowerCase() || "jpg");
    const artDestUri = `${MUSIC_DIR}${id}_art.${artExt}`;
    try {
      if (artSourceUri.startsWith("data:")) {
        const base64 = artSourceUri.replace(/^data:image\/\w+;base64,/, "");
        await FileSystem.writeAsStringAsync(artDestUri, base64, { encoding: FileSystem.EncodingType.Base64 });
        artUri = artDestUri;
      } else {
        await FileSystem.copyAsync({ from: artSourceUri, to: artDestUri });
        artUri = artDestUri;
      }
    } catch {
      // ignore art copy failure
    }
  }
  const track: SavedTrack = { id, name, artist, uri: destUri, artUri };
  const tracks = await loadManifest();
  tracks.push(track);
  await saveManifest(tracks);
  return track;
}

/** Remove a track from the library and delete its audio and art files. */
export async function removeTrackFromLibrary(id: string): Promise<void> {
  const tracks = await loadManifest();
  const track = tracks.find((t) => t.id === id);
  for (const uri of [track?.uri, track?.artUri]) {
    if (!uri) continue;
    try {
      const info = await FileSystem.getInfoAsync(uri);
      if (info.exists) await FileSystem.deleteAsync(uri);
    } catch {
      // ignore
    }
  }
  const next = tracks.filter((t) => t.id !== id);
  await saveManifest(next);
}
