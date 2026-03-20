import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Platform,
  useWindowDimensions,
  StatusBar,
} from "react-native";
import { Video, ResizeMode } from "expo-av";
import { useRouter, useLocalSearchParams } from "expo-router";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SERVER_URL } from "../config";

/** Matches preview / studio vertical frame; video uses CONTAIN inside. */
const VIDEO_ASPECT = 9 / 16;

export default function ResultScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();
  const params = useLocalSearchParams();
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [downloadedFileUri, setDownloadedFileUri] = useState<string | null>(null);
  const videoRef = React.useRef<Video>(null);
  const preDownloadStartedRef = React.useRef(false);

  const videoUrl = params.videoUrl as string;
  const videoName = params.videoName as string;
  const encodedVideoUrl = videoUrl ? encodeURI(videoUrl) : "";
  const fullVideoUrl = `${SERVER_URL}${encodedVideoUrl}`;

  const safeTop =
    insets.top > 0 ? insets.top : Platform.OS === "ios" ? 52 : StatusBar.currentHeight ?? 24;
  /** Thin header: one row (back + text) + small vertical padding */
  const HEADER_HEIGHT = safeTop + 8 + 44 + 12;
  const bottomPad = Math.max(insets.bottom, 12) + 16;
  const sidePad = 24;

  const { videoW, videoH } = useMemo(() => {
    const maxW = Math.min(winW - sidePad * 2, 340) * 0.95;
    const idealH = maxW / VIDEO_ASPECT;
    // Label + hint + action row + card padding (stable so video doesn’t resize when download completes)
    const cardChrome = 16 * 2 + 28 + 10 + 12 + 54 + 8;
    const available = winH - HEADER_HEIGHT - bottomPad - cardChrome;
    const maxVideoH = Math.max(160, Math.min(idealH, available * 0.95));
    const h = Math.min(idealH, maxVideoH);
    const w = h * VIDEO_ASPECT;
    return { videoW: w, videoH: h };
  }, [winW, winH, HEADER_HEIGHT, bottomPad]);

  // Pre-download video for instant save/share
  React.useEffect(() => {
    async function preDownloadVideo() {
      if (preDownloadStartedRef.current || !fullVideoUrl) return;
      preDownloadStartedRef.current = true;

      try {
        const timestamp = Date.now();
        const safeName = videoName || "export.mp4";
        const fileUri = `${FileSystem.documentDirectory}${timestamp}_${safeName}`;
        const downloadResult = await FileSystem.downloadAsync(fullVideoUrl, fileUri);

        if (downloadResult.uri) {
          setDownloadedFileUri(downloadResult.uri);
        }
      } catch (error) {
        console.error("Pre-download failed:", error);
        preDownloadStartedRef.current = false;
      }
    }

    preDownloadVideo();
  }, [fullVideoUrl, videoName]);

  async function saveToGallery() {
    try {
      setSaving(true);

      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Permission Denied", "We need permission to save to your gallery.");
        setSaving(false);
        return;
      }

      let fileUri = downloadedFileUri;

      if (!fileUri) {
        const timestamp = Date.now();
        fileUri = `${FileSystem.documentDirectory}${timestamp}_${videoName}`;
        const downloadResult = await FileSystem.downloadAsync(fullVideoUrl, fileUri);
        fileUri = downloadResult.uri;
      }

      if (!fileUri) {
        throw new Error("Download failed - no URI returned");
      }

      const asset = await MediaLibrary.createAssetAsync(fileUri);

      try {
        await MediaLibrary.createAlbumAsync("Video Studio", asset, false);
      } catch {
        const album = await MediaLibrary.getAlbumAsync("Video Studio");
        if (album) {
          await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
        }
      }

      Alert.alert("Saved", "Video saved to your gallery.");
    } catch (err) {
      console.error("Save error:", err);
      const message = err instanceof Error ? err.message : String(err);
      Alert.alert("Save Failed", `Could not save video: ${message || "Unknown error"}`);
    } finally {
      setSaving(false);
    }
  }

  async function shareVideo() {
    try {
      setSharing(true);

      let fileUri = downloadedFileUri;

      if (!fileUri) {
        const timestamp = Date.now();
        fileUri = `${FileSystem.documentDirectory}${timestamp}_${videoName}`;
        const downloadResult = await FileSystem.downloadAsync(fullVideoUrl, fileUri);
        fileUri = downloadResult.uri;
      }

      if (!fileUri) {
        throw new Error("Download failed - no URI returned");
      }

      const isAvailable = await Sharing.isAvailableAsync();
      if (!isAvailable) {
        Alert.alert("Sharing Not Available", "Sharing is not supported on this device.");
        setSharing(false);
        return;
      }

      await Sharing.shareAsync(fileUri, {
        mimeType: "video/mp4",
        dialogTitle: "Share your video",
      });
    } catch (err) {
      console.error("Share error:", err);
      const message = err instanceof Error ? err.message : String(err);
      Alert.alert("Share Failed", `Could not share video: ${message || "Unknown error"}`);
    } finally {
      setSharing(false);
    }
  }

  function createNew() {
    router.replace("/");
  }

  const displayName = videoName ? videoName.replace(/\.[^/.]+$/, "") : "Your montage";

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: safeTop + 8, paddingBottom: 12 }]}>
        <View style={styles.headerBackground} />

        <View style={styles.headerRow}>
          <TouchableOpacity
            style={styles.headerBackBtn}
            onPress={createNew}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Back to studio"
          >
            <Ionicons name="arrow-back" size={22} color="#6366f1" />
          </TouchableOpacity>
          <View style={styles.headerTitles}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              Export ready
            </Text>
            <Text style={styles.headerSubtitle} numberOfLines={1}>
              {displayName}
            </Text>
          </View>
        </View>
      </View>

      <View style={[styles.body, { paddingBottom: bottomPad }]}>
        <View style={[styles.videoCard, { maxWidth: winW - sidePad * 2 }]}>
          <Text style={styles.cardLabel}>Preview</Text>

          <View style={[styles.videoFrame, { width: videoW, height: videoH }]}>
            <Video
              ref={videoRef}
              source={{ uri: fullVideoUrl }}
              style={StyleSheet.absoluteFillObject}
              useNativeControls
              resizeMode={ResizeMode.CONTAIN}
              shouldPlay
              isLooping
              onError={(e) => {
                console.error("Video error:", e);
                Alert.alert("Video Error", "Could not load video. Check server connection.");
              }}
            />
          </View>

          <View style={styles.actionsRow}>
            <TouchableOpacity
              style={[styles.actionButton, styles.actionOutline]}
              onPress={saveToGallery}
              disabled={saving}
              activeOpacity={0.85}
            >
              <Ionicons name="download-outline" size={20} color="#6366f1" />
              <Text style={styles.actionOutlineText}>{saving ? "Saving…" : "Save"}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionButton, styles.actionPrimary]}
              onPress={shareVideo}
              disabled={sharing}
              activeOpacity={0.85}
            >
              <Ionicons name="share-outline" size={20} color="#fff" />
              <Text style={styles.actionPrimaryText}>{sharing ? "Preparing…" : "Share"}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#f5f7fb",
  },
  header: {
    paddingHorizontal: 20,
    position: "relative",
    overflow: "hidden",
  },
  headerBackground: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#6366f1",
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    zIndex: 2,
    minHeight: 44,
  },
  headerBackBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#fff",
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#6366f1",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 3,
  },
  headerTitles: {
    flex: 1,
    marginLeft: 12,
    minWidth: 0,
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: "900",
    color: "#fff",
    letterSpacing: -0.3,
  },
  headerSubtitle: {
    fontSize: 13,
    color: "rgba(255, 255, 255, 0.9)",
    fontWeight: "600",
    marginTop: 2,
  },
  body: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  videoCard: {
    width: "100%",
    alignSelf: "center",
    backgroundColor: "#fff",
    borderRadius: 22,
    paddingTop: 14,
    paddingBottom: 16,
    paddingHorizontal: 16,
    alignItems: "center",
    shadowColor: "#0f172a",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 14,
    elevation: 4,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  cardLabel: {
    alignSelf: "flex-start",
    fontSize: 12,
    fontWeight: "800",
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: 0.55,
    marginBottom: 10,
    marginLeft: 2,
  },
  videoFrame: {
    alignSelf: "center",
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: "#0f172a",
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 16,
    width: "100%",
  },
  actionButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 13,
    borderRadius: 14,
    minWidth: 0,
  },
  actionOutline: {
    backgroundColor: "#fff",
    borderWidth: 2,
    borderColor: "#6366f1",
  },
  actionOutlineText: {
    fontSize: 15,
    fontWeight: "800",
    color: "#6366f1",
    letterSpacing: -0.2,
  },
  actionPrimary: {
    backgroundColor: "#6366f1",
    shadowColor: "#6366f1",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 5,
  },
  actionPrimaryText: {
    fontSize: 15,
    fontWeight: "800",
    color: "#fff",
    letterSpacing: -0.2,
  },
});
