import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Alert, Platform } from "react-native";
import { Video, ResizeMode } from "expo-av";
import { useRouter, useLocalSearchParams } from "expo-router";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library";
import { Ionicons } from "@expo/vector-icons";
import { SERVER_URL } from "../config";

const SAFE_TOP = Platform.OS === "ios" ? 52 : 44;
const BOTTOM_BAR_HEIGHT = 96;

export default function ResultScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [downloadedFileUri, setDownloadedFileUri] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const videoRef = React.useRef<Video>(null);

  const videoUrl = params.videoUrl as string;
  const videoName = params.videoName as string;
  const encodedVideoUrl = videoUrl ? encodeURI(videoUrl) : "";
  const fullVideoUrl = `${SERVER_URL}${encodedVideoUrl}`;

  // Pre-download video for instant save/share
  React.useEffect(() => {
    async function preDownloadVideo() {
      if (downloadedFileUri || isDownloading) return;
      
      try {
        setIsDownloading(true);
        const timestamp = Date.now();
        const fileUri = `${FileSystem.documentDirectory}${timestamp}_${videoName}`;
        
        console.log("Pre-downloading video to:", fileUri);
        const downloadResult = await FileSystem.downloadAsync(fullVideoUrl, fileUri);
        
        if (downloadResult.uri) {
          setDownloadedFileUri(downloadResult.uri);
          console.log("✓ Video pre-downloaded successfully");
        }
      } catch (error) {
        console.error("Pre-download failed:", error);
      } finally {
        setIsDownloading(false);
      }
    }
    
    if (fullVideoUrl) {
      preDownloadVideo();
    }
  }, [fullVideoUrl]);

  async function saveToGallery() {
    try {
      setSaving(true);

      // Request permissions
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Permission Denied", "We need permission to save to your gallery.");
        setSaving(false);
        return;
      }

      // Use pre-downloaded file if available, otherwise download now
      let fileUri = downloadedFileUri;
      
      if (!fileUri) {
        console.log("No pre-downloaded file, downloading now...");
        const timestamp = Date.now();
        fileUri = `${FileSystem.documentDirectory}${timestamp}_${videoName}`;
        const downloadResult = await FileSystem.downloadAsync(fullVideoUrl, fileUri);
        fileUri = downloadResult.uri;
      } else {
        console.log("Using pre-downloaded file:", fileUri);
      }

      if (!fileUri) {
        throw new Error("Download failed - no URI returned");
      }

      // Save to gallery
      const asset = await MediaLibrary.createAssetAsync(fileUri);
      
      // Try to create album, but don't fail if it exists
      try {
        await MediaLibrary.createAlbumAsync("Video Studio", asset, false);
      } catch {
        // Album might already exist
        const album = await MediaLibrary.getAlbumAsync("Video Studio");
        if (album) {
          await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
        }
      }

      Alert.alert("✅ Saved!", "Video saved to your gallery.");
    } catch (err) {
      console.error("Save error:", err);
      Alert.alert("Save Failed", `Could not save video: ${err.message || 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  }

  async function shareVideo() {
    try {
      setSharing(true);

      // Use pre-downloaded file if available, otherwise download now
      let fileUri = downloadedFileUri;
      
      if (!fileUri) {
        console.log("No pre-downloaded file, downloading now...");
        const timestamp = Date.now();
        fileUri = `${FileSystem.documentDirectory}${timestamp}_${videoName}`;
        const downloadResult = await FileSystem.downloadAsync(fullVideoUrl, fileUri);
        fileUri = downloadResult.uri;
      } else {
        console.log("Using pre-downloaded file:", fileUri);
      }

      if (!fileUri) {
        throw new Error("Download failed - no URI returned");
      }

      // Check if sharing is available
      const isAvailable = await Sharing.isAvailableAsync();
      if (!isAvailable) {
        Alert.alert("Sharing Not Available", "Sharing is not supported on this device.");
        setSharing(false);
        return;
      }

      // Share the video
      await Sharing.shareAsync(fileUri, {
        mimeType: "video/mp4",
        dialogTitle: "Share your video",
      });
    } catch (err) {
      console.error("Share error:", err);
      Alert.alert("Share Failed", `Could not share video: ${err.message || 'Unknown error'}`);
    } finally {
      setSharing(false);
    }
  }

  function createNew() {
    router.replace("/");
  }

  return (
    <View style={styles.container}>
      <View style={styles.videoWrapper}>
        <Video
          ref={videoRef}
          source={{ uri: fullVideoUrl }}
          style={StyleSheet.absoluteFill}
          useNativeControls
          resizeMode={ResizeMode.CONTAIN}
          shouldPlay
          isLooping
          onError={(e) => {
            console.error("Video error:", e);
            Alert.alert("Video Error", "Could not load video. Check server connection.");
          }}
        />
        <TouchableOpacity
          style={styles.backOverlay}
          onPress={createNew}
          activeOpacity={0.8}
        >
          <Ionicons name="arrow-back" size={26} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Bottom bar: Download + Share */}
      <View style={styles.bottomBar}>
        <TouchableOpacity
          style={[styles.bottomButton, styles.downloadButton]}
          onPress={saveToGallery}
          disabled={saving}
          activeOpacity={0.85}
        >
          <Ionicons name="download-outline" size={24} color="#fff" />
          <Text style={styles.bottomButtonText}>{saving ? "Saving…" : "Save"}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.bottomButton, styles.shareButton]}
          onPress={shareVideo}
          disabled={sharing}
          activeOpacity={0.85}
        >
          <Ionicons name="share-outline" size={24} color="#fff" />
          <Text style={styles.bottomButtonText}>{sharing ? "Preparing…" : "Share"}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  videoWrapper: {
    flex: 1,
    position: "relative",
  },
  backOverlay: {
    position: "absolute",
    top: SAFE_TOP,
    left: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    alignItems: "center",
  },
  bottomBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    height: BOTTOM_BAR_HEIGHT,
    paddingHorizontal: 20,
    paddingBottom: Platform.OS === "ios" ? 28 : 20,
    backgroundColor: "rgba(0,0,0,0.7)",
  },
  bottomButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 999,
    minWidth: 120,
  },
  downloadButton: {
    backgroundColor: "#10b981",
    shadowColor: "#10b981",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 4,
  },
  shareButton: {
    backgroundColor: "#6366f1",
    shadowColor: "#6366f1",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 4,
  },
  bottomButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
});