import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Alert, ScrollView, Dimensions } from "react-native";
import { Video, ResizeMode } from "expo-av";
import { useRouter, useLocalSearchParams } from "expo-router";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library";
import { Ionicons } from "@expo/vector-icons";

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const SERVER_URL = "http://192.168.68.107:8000";

export default function ResultScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 });
  const [downloadedFileUri, setDownloadedFileUri] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const videoRef = React.useRef<Video>(null);
  const hasInitialized = React.useRef(false); // Track if already initialized

  const videoUrl = params.videoUrl as string;
  const videoName = params.videoName as string;
  
  // URL encode the path to handle spaces and special characters
  const encodedVideoUrl = videoUrl ? encodeURI(videoUrl) : '';
  const fullVideoUrl = `${SERVER_URL}${encodedVideoUrl}`;

  console.log("====== RESULT SCREEN DEBUG ======");
  console.log("Params received:", params);
  console.log("Video URL param:", videoUrl);
  console.log("Encoded Video URL:", encodedVideoUrl);
  console.log("Video Name param:", videoName);
  console.log("Full Video URL:", fullVideoUrl);
  console.log("================================");

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

  async function toggleFullscreen() {
    if (videoRef.current) {
      try {
        await videoRef.current.presentFullscreenPlayer();
      } catch (error) {
        console.error("Fullscreen error:", error);
      }
    }
  }

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <TouchableOpacity 
            style={styles.backButton}
            onPress={createNew}
            activeOpacity={0.7}
          >
            <Ionicons name="arrow-back" size={24} color="#fff" />
          </TouchableOpacity>
          <View>
            <Text style={styles.headerTitle}>Your Video</Text>
            <Text style={styles.headerSubtitle}>Ready to share!</Text>
          </View>
        </View>

        <TouchableOpacity 
          activeOpacity={1} 
          onPress={toggleFullscreen}
          style={styles.videoTouchable}
        >
          <Video
            ref={videoRef}
            source={{ uri: fullVideoUrl }}
            style={[
              styles.video,
              videoSize.width && videoSize.height && {
                height: (SCREEN_WIDTH * videoSize.height) / videoSize.width
              }
            ]}
            useNativeControls
            resizeMode={ResizeMode.CONTAIN}
            shouldPlay
            isLooping
            onError={(error) => {
              console.error("Video error:", error);
              Alert.alert("Video Error", "Could not load video. Check server connection.");
            }}
            onLoad={(status) => {
              console.log("Video loaded successfully");
              if (status.isLoaded && status.naturalSize) {
                setVideoSize({
                  width: status.naturalSize.width,
                  height: status.naturalSize.height
                });
                console.log("Video dimensions:", status.naturalSize);
              }
            }}
          />
        </TouchableOpacity>

        <View style={styles.actionsContainer}>
          <View style={styles.infoCard}>
            <View style={styles.infoRow}>
              <View style={styles.infoIconBg}>
                <Text style={styles.infoIcon}>🎬</Text>
              </View>
              <View style={styles.infoText}>
                <Text style={styles.infoTitle} numberOfLines={1}>{videoName}</Text>
                <Text style={styles.infoSubtitle}>AI-generated montage</Text>
              </View>
            </View>
          </View>

          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={styles.saveButton}
              onPress={saveToGallery}
              disabled={saving}
              activeOpacity={0.8}
            >
              <View style={styles.buttonContent}>
                {saving ? (
                  <Text style={styles.buttonIcon}>⏳</Text>
                ) : (
                  <Ionicons name="download-outline" size={28} color="#fff" />
                )}
                <Text style={styles.buttonText}>
                  {saving ? "Saving..." : "Save"}
                </Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.shareButton}
              onPress={shareVideo}
              disabled={sharing}
              activeOpacity={0.8}
            >
              <View style={styles.buttonContent}>
                {sharing ? (
                  <Text style={styles.buttonIcon}>⏳</Text>
                ) : (
                  <Ionicons name="share-outline" size={28} color="#fff" />
                )}
                <Text style={styles.buttonText}>
                  {sharing ? "Preparing..." : "Share"}
                </Text>
              </View>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={styles.newButton}
            onPress={createNew}
            activeOpacity={0.8}
          >
            <Ionicons name="add-circle-outline" size={24} color="#6366f1" />
            <Text style={styles.newButtonText}>Create New Video</Text>
          </TouchableOpacity>
        </View>
        
        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f7fb",
  },
  scrollView: {
    flex: 1,
  },
  header: {
    backgroundColor: "#6366f1",
    paddingTop: 60,
    paddingBottom: 24,
    paddingHorizontal: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    justifyContent: "center",
    alignItems: "center",
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: "900",
    color: "#fff",
    marginBottom: 4,
    letterSpacing: -0.5,
  },
  headerSubtitle: {
    fontSize: 15,
    color: "rgba(255, 255, 255, 0.95)",
    fontWeight: "600",
  },
  videoTouchable: {
    width: "100%",
    backgroundColor: "#000",
  },
  video: {
    width: "100%",
    minHeight: 200,
    backgroundColor: "#000",
  },
  actionsContainer: {
    paddingHorizontal: 24,
    paddingTop: 24,
  },
  infoCard: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 20,
    marginBottom: 24,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 14,
    elevation: 3,
  },
  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  infoIconBg: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#eef2ff",
    justifyContent: "center",
    alignItems: "center",
  },
  infoIcon: {
    fontSize: 28,
  },
  infoText: {
    flex: 1,
  },
  infoTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#0f172a",
    marginBottom: 4,
  },
  infoSubtitle: {
    fontSize: 14,
    color: "#64748b",
    fontWeight: "600",
  },
  buttonRow: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 16,
  },
  saveButton: {
    flex: 1,
    backgroundColor: "#10b981",
    borderRadius: 16,
    paddingVertical: 18,
    shadowColor: "#10b981",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 5,
  },
  shareButton: {
    flex: 1,
    backgroundColor: "#6366f1",
    borderRadius: 16,
    paddingVertical: 18,
    shadowColor: "#6366f1",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 5,
  },
  buttonContent: {
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  buttonIcon: {
    fontSize: 28,
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: -0.3,
  },
  newButton: {
    backgroundColor: "#fff",
    borderRadius: 16,
    paddingVertical: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    borderWidth: 2,
    borderColor: "#e2e8f0",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  newButtonText: {
    fontSize: 16,
    fontWeight: "800",
    color: "#6366f1",
    letterSpacing: -0.3,
  },
});