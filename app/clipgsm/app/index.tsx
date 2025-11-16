import React, { useState, useEffect } from "react";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { Video, ResizeMode } from "expo-av";
import { View, Text, TouchableOpacity, Image, ScrollView, Alert, ActivityIndicator, StyleSheet, Dimensions } from "react-native";

const { width } = Dimensions.get('window');

interface MediaItem {
  uri: string;
  filename?: string;
  type: "image" | "video";
  uploading?: boolean;
  uploaded?: boolean;
}

export default function ExploreScreen() {
  const [mediaList, setMediaList] = useState<MediaItem[]>([]);
  const [song, setSong] = useState<{ uri: string; name: string } | null>(null);
  const [songUploading, setSongUploading] = useState(false);
  const [songUploaded, setSongUploaded] = useState(false);
  const [generateLoading, setGenerateLoading] = useState(false);
  const [duration, setDuration] = useState<number>(30);

  const SERVER_URL = "http://10.121.222.165:8000";

  // Check if all media and song are uploaded
  const allUploaded = mediaList.length > 0 && 
                      mediaList.every(m => m.uploaded) && 
                      song !== null && 
                      songUploaded;

  async function uploadSingleFile(file: MediaItem, index: number) {
    const formData = new FormData();
    
    formData.append("files", {
      uri: file.uri,
      name: file.filename || `file_${index}.${file.type === "video" ? "mp4" : "jpg"}`,
      type: file.type === "video" ? "video/mp4" : "image/jpeg",
    } as any);

    try {
      const res = await fetch(`${SERVER_URL}/upload-single`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        throw new Error("Upload failed");
      }

      return true;
    } catch (err) {
      console.error("Upload error:", err);
      return false;
    }
  }

  async function uploadMediaSequentially(files: MediaItem[], startIdx: number) {
    for (let i = 0; i < files.length; i++) {
      const actualIndex = startIdx + i;
      
      // Mark current file as uploading
      setMediaList(prev => prev.map((item, idx) => 
        idx === actualIndex ? { ...item, uploading: true } : item
      ));

      const success = await uploadSingleFile(files[i], i);

      // Mark as uploaded or failed
      setMediaList(prev => prev.map((item, idx) => 
        idx === actualIndex ? { ...item, uploading: false, uploaded: success } : item
      ));

      if (!success) {
        Alert.alert("Upload Failed", `Failed to upload ${files[i].filename}`);
        break;
      }
    }
  }

  async function pickMedia() {
    const { granted } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!granted) {
      Alert.alert("Permission Required", "We need access to your gallery to select media.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      allowsMultipleSelection: true,
      selectionLimit: 0,
      quality: 1,
    });

    if (!result.canceled) {
      const newFiles = result.assets.map((asset, index) => ({
        uri: asset.uri,
        filename: asset.fileName || `file_${index}.${asset.type === "video" ? "mp4" : "jpg"}`,
        type: asset.type as "image" | "video",
        uploading: false,
        uploaded: false,
      }));

      // If adding more files, append. Otherwise replace.
      const shouldAppend = mediaList.length > 0;
      
      if (shouldAppend) {
        const startIndex = mediaList.length; // Calculate BEFORE updating state
        setMediaList(prev => [...prev, ...newFiles]);
        // Start uploading with the correct start index
        uploadMediaSequentially(newFiles, startIndex);
      } else {
        // Clear uploads folder before starting fresh (first time only)
        try {
          await fetch(`${SERVER_URL}/clear-uploads`, {
            method: "POST",
          });
        } catch (err) {
          console.error("Failed to clear uploads:", err);
        }
        setMediaList(newFiles);
        // Start from index 0 for first batch
        uploadMediaSequentially(newFiles, 0);
      }
    }
  }

  async function uploadSongFile() {
    if (!song) return;

    const formData = new FormData();
    formData.append("song", {
      uri: song.uri,
      name: song.name,
      type: "audio/mpeg",
    } as any);
    formData.append("max_duration", duration.toString());

    try {
      setSongUploading(true);
      const res = await fetch(`${SERVER_URL}/upload-song`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        throw new Error("Song upload failed");
      }

      setSongUploaded(true);
    } catch (err) {
      console.error(err);
      Alert.alert("Upload Failed", "Could not upload song.");
      setSongUploaded(false);
    } finally {
      setSongUploading(false);
    }
  }

  async function pickSong() {
    try {
      const result = await DocumentPicker.getDocumentAsync({ 
        type: "audio/*", 
        copyToCacheDirectory: true 
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const asset = result.assets[0];
        setSong({
          uri: asset.uri,
          name: asset.name || "song.mp3",
        });
        setSongUploaded(false);
      }
    } catch (err) {
      console.error("Song picker error:", err);
      Alert.alert("Error", "Could not select song.");
    }
  }

  // Auto-upload song when selected or duration changes
  useEffect(() => {
    if (song && !songUploading && !songUploaded) {
      uploadSongFile();
    }
  }, [song, duration]);

  async function generateVideo() {
    try {
      setGenerateLoading(true);
      
      const res = await fetch(`${SERVER_URL}/run_ai`, {
        method: "POST",
      });

      if (!res.ok) {
        return Alert.alert("Generation Failed", "Backend returned an error.");
      }
      
      const data = await res.json();
      Alert.alert("🎉 Video Generated!", `Video saved at: ${data.video_path}`);
    }
    catch (err) {
      console.error(err);
      Alert.alert("Generation Failed", "Check your network connection.");
    }
    finally {
      setGenerateLoading(false);
    }
  }

  function removeMedia(index: number) {
    const newMediaList = mediaList.filter((_, i) => i !== index);
    setMediaList(newMediaList);
  }

  function renderMediaItem(item: MediaItem, index: number) {
    return (
      <View key={index} style={styles.mediaCard}>
        <View style={styles.mediaContent}>
          {item.type === "image" && (
            <Image source={{ uri: item.uri }} style={styles.mediaThumbnail} />
          )}
          {item.type === "video" && (
            <Video
              source={{ uri: item.uri }}
              useNativeControls={false}
              resizeMode={ResizeMode.COVER}
              style={styles.mediaThumbnail}
            />
          )}
          
          {/* Upload overlay */}
          {(item.uploading || !item.uploaded) && (
            <View style={styles.uploadOverlay}>
              {item.uploading && (
                <>
                  <ActivityIndicator size="large" color="#fff" />
                  <Text style={styles.uploadingText}>Uploading...</Text>
                </>
              )}
              {!item.uploading && !item.uploaded && (
                <View style={styles.queuedIndicator}>
                  <Text style={styles.queuedText}>⏳</Text>
                </View>
              )}
            </View>
          )}
          
          {/* Success checkmark */}
          {item.uploaded && (
            <View style={styles.uploadedBadge}>
              <Text style={styles.uploadedText}>✓</Text>
            </View>
          )}
        </View>
        <View style={styles.mediaTypeTag}>
          <Text style={styles.mediaTypeText}>
            {item.type === "video" ? "VIDEO" : "PHOTO"}
          </Text>
        </View>
        <TouchableOpacity 
          style={styles.deleteButton}
          onPress={() => removeMedia(index)}
          activeOpacity={0.7}
        >
          <Text style={styles.deleteButtonText}>×</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerBackground} />
        <Text style={styles.headerTitle}>Video Studio</Text>
        <Text style={styles.headerSubtitle}>Create cinematic memories</Text>
        <View style={styles.headerDecor1} />
        <View style={styles.headerDecor2} />
      </View>

      <ScrollView 
        style={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Media Section */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionTitleRow}>
              <View style={styles.sectionIconBg}>
                <Text style={styles.sectionIcon}>📸</Text>
              </View>
              <View>
                <Text style={styles.sectionTitle}>Media Gallery</Text>
                <Text style={styles.sectionSubtitle}>Photos & Videos</Text>
              </View>
            </View>
            <View style={styles.countBadge}>
              <Text style={styles.countBadgeText}>{mediaList.length}</Text>
            </View>
          </View>

          {mediaList.length === 0 ? (
            <TouchableOpacity 
              style={styles.emptyCard} 
              onPress={pickMedia}
              activeOpacity={0.7}
            >
              <View style={styles.emptyIconContainer}>
                <Text style={styles.emptyIcon}>🎬</Text>
              </View>
              <Text style={styles.emptyTitle}>Add Your Media</Text>
              <Text style={styles.emptySubtitle}>Tap to select photos and videos</Text>
              <View style={styles.emptyHint}>
                <Text style={styles.emptyHintText}>Auto-uploads on select</Text>
              </View>
            </TouchableOpacity>
          ) : (
            <ScrollView 
              horizontal 
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.mediaGrid}
            >
              {mediaList.map((item, index) => renderMediaItem(item, index))}
              <TouchableOpacity 
                style={styles.addMoreCard}
                onPress={pickMedia}
                activeOpacity={0.7}
              >
                <Text style={styles.addMoreIcon}>+</Text>
                <Text style={styles.addMoreText}>Add more</Text>
              </TouchableOpacity>
            </ScrollView>
          )}
        </View>

        {/* Audio Section */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionTitleRow}>
              <View style={styles.sectionIconBg}>
                <Text style={styles.sectionIcon}>🎵</Text>
              </View>
              <View>
                <Text style={styles.sectionTitle}>Soundtrack</Text>
                <Text style={styles.sectionSubtitle}>Background Music</Text>
              </View>
            </View>
          </View>

          {!song ? (
            <TouchableOpacity 
              style={styles.audioCard} 
              onPress={pickSong}
              activeOpacity={0.7}
            >
              <View style={styles.audioIconContainer}>
                <Text style={styles.audioIcon}>🎵</Text>
              </View>
              <View style={styles.audioTextContainer}>
                <Text style={styles.audioTitle}>Add Background Music</Text>
                <Text style={styles.audioSubtitle}>Required • MP3, WAV, M4A</Text>
              </View>
              <View style={styles.chevronContainer}>
                <Text style={styles.chevron}>›</Text>
              </View>
            </TouchableOpacity>
          ) : (
            <View style={[
              styles.audioCardSelected,
              songUploading && styles.audioCardUploading
            ]}>
              <View style={styles.audioIconContainerSelected}>
                {songUploading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : songUploaded ? (
                  <Text style={styles.audioIcon}>✓</Text>
                ) : (
                  <Text style={styles.audioIcon}>🎵</Text>
                )}
              </View>
              <View style={styles.audioTextContainer}>
                <Text style={styles.audioTitleSelected} numberOfLines={1}>{song.name}</Text>
                <Text style={styles.audioSubtitleSelected}>
                  {songUploading ? "Uploading..." : songUploaded ? "Ready to create" : "Waiting..."}
                </Text>
              </View>
              <TouchableOpacity onPress={pickSong} style={styles.changeButton}>
                <Text style={styles.changeButtonText}>Change</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                onPress={() => {
                  setSong(null);
                  setSongUploaded(false);
                }} 
                style={styles.deleteSongButton}
              >
                <Text style={styles.deleteSongText}>×</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Duration Section */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionTitleRow}>
              <View style={styles.sectionIconBg}>
                <Text style={styles.sectionIcon}>⏱️</Text>
              </View>
              <View>
                <Text style={styles.sectionTitle}>Video Length</Text>
                <Text style={styles.sectionSubtitle}>Choose duration</Text>
              </View>
            </View>
          </View>

          <View style={styles.durationRow}>
            {[15, 30, 45, 60].map((sec) => (
              <TouchableOpacity
                key={sec}
                style={[
                  styles.durationButton,
                  duration === sec && styles.durationButtonActive
                ]}
                onPress={() => {
                  setDuration(sec);
                  setSongUploaded(false); // Trigger re-upload with new duration
                }}
                activeOpacity={0.7}
              >
                <Text style={[
                  styles.durationText,
                  duration === sec && styles.durationTextActive
                ]}>
                  {sec}s
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Generate Button */}
        <View style={styles.section}>
          <TouchableOpacity 
            style={[
              styles.generateButton, 
              !allUploaded && styles.buttonDisabled
            ]}
            onPress={generateVideo}
            activeOpacity={0.8}
            disabled={generateLoading || !allUploaded}
          >
            {generateLoading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <Text style={styles.buttonIcon}>✨</Text>
                <Text style={styles.buttonText}>
                  {allUploaded ? "Generate Video" : "Upload files first"}
                </Text>
              </>
            )}
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
  header: {
    backgroundColor: "#6366f1",
    paddingTop: 60,
    paddingBottom: 30,
    paddingHorizontal: 24,
    position: 'relative',
    overflow: 'hidden',
  },
  headerBackground: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#6366f1',
  },
  headerTitle: {
    fontSize: 36,
    fontWeight: "900",
    color: "#fff",
    marginBottom: 6,
    letterSpacing: -0.5,
    zIndex: 1,
  },
  headerSubtitle: {
    fontSize: 17,
    color: "rgba(255, 255, 255, 0.95)",
    fontWeight: "600",
    zIndex: 1,
  },
  headerDecor1: {
    position: 'absolute',
    right: -30,
    top: 50,
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  headerDecor2: {
    position: 'absolute',
    right: -10,
    top: 110,
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
  },
  content: {
    flex: 1,
  },
  section: {
    paddingHorizontal: 24,
    marginTop: 28,
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  sectionIconBg: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: "#6366f1",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 3,
  },
  sectionIcon: {
    fontSize: 22,
  },
  sectionTitle: {
    fontSize: 21,
    fontWeight: "800",
    color: "#0f172a",
    letterSpacing: -0.4,
  },
  sectionSubtitle: {
    fontSize: 13,
    color: "#64748b",
    fontWeight: "600",
    marginTop: 2,
  },
  countBadge: {
    backgroundColor: '#6366f1',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 14,
    minWidth: 36,
    alignItems: 'center',
    shadowColor: "#6366f1",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 3,
  },
  countBadgeText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
  },
  emptyCard: {
    backgroundColor: '#fff',
    borderRadius: 24,
    padding: 48,
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
  },
  emptyIconContainer: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: '#eef2ff',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
    shadowColor: "#6366f1",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.15,
    shadowRadius: 10,
    elevation: 3,
  },
  emptyIcon: {
    fontSize: 44,
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: "800",
    color: "#0f172a",
    marginBottom: 8,
    letterSpacing: -0.4,
  },
  emptySubtitle: {
    fontSize: 15,
    color: "#475569",
    fontWeight: "600",
    marginBottom: 18,
  },
  emptyHint: {
    backgroundColor: '#eef2ff',
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 12,
  },
  emptyHintText: {
    color: '#6366f1',
    fontSize: 13,
    fontWeight: '700',
  },
  mediaGrid: {
    paddingVertical: 8,
  },
  mediaCard: {
    marginRight: 14,
    borderRadius: 20,
    backgroundColor: "#fff",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 14,
    elevation: 5,
    overflow: "hidden",
  },
  mediaContent: {
    position: "relative",
  },
  mediaThumbnail: {
    width: 170,
    height: 240,
    backgroundColor: "#e2e8f0",
  },
  mediaOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 80,
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
  },
  playIcon: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(99, 102, 241, 0.95)',
    justifyContent: "center",
    alignItems: "center",
    transform: [{ translateX: -28 }, { translateY: -28 }],
    shadowColor: "#6366f1",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 5,
  },
  playIconText: {
    color: "#fff",
    fontSize: 22,
    fontWeight: '700',
    marginLeft: 4,
  },
  uploadOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  uploadingText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
    marginTop: 12,
  },
  queuedIndicator: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  queuedText: {
    fontSize: 32,
  },
  uploadedBadge: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(16, 185, 129, 0.9)',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: "#10b981",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    elevation: 2,
  },
  uploadedText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  mediaTypeTag: {
    position: "absolute",
    bottom: 8,
    right: 8,
    backgroundColor: "rgba(15, 23, 42, 0.75)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  mediaTypeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  addMoreCard: {
    width: 170,
    height: 240,
    borderRadius: 20,
    backgroundColor: '#e2e8f0',
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2,
  },
  addMoreIcon: {
    fontSize: 52,
    color: "#64748b",
    marginBottom: 12,
    fontWeight: '300',
  },
  addMoreText: {
    fontSize: 17,
    fontWeight: "700",
    color: "#64748b",
  },
  audioCard: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 20,
    flexDirection: "row",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 14,
    elevation: 3,
  },
  audioCardSelected: {
    backgroundColor: '#6366f1',
    borderRadius: 20,
    padding: 20,
    flexDirection: "row",
    alignItems: "center",
    shadowColor: "#6366f1",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 18,
    elevation: 6,
  },
  audioCardUploading: {
    backgroundColor: '#94a3b8',
  },
  audioIconContainer: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#fef2f2',
    justifyContent: "center",
    alignItems: "center",
    marginRight: 16,
    shadowColor: "#ef4444",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 3,
  },
  audioIconContainerSelected: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 16,
  },
  audioIcon: {
    fontSize: 30,
  },
  audioTextContainer: {
    flex: 1,
  },
  audioTitle: {
    fontSize: 17,
    fontWeight: "800",
    color: "#0f172a",
    marginBottom: 4,
    letterSpacing: -0.3,
  },
  audioTitleSelected: {
    fontSize: 17,
    fontWeight: "800",
    color: "#fff",
    marginBottom: 4,
    letterSpacing: -0.3,
  },
  audioSubtitle: {
    fontSize: 13,
    color: "#64748b",
    fontWeight: "600",
  },
  audioSubtitleSelected: {
    fontSize: 13,
    color: "rgba(255, 255, 255, 0.9)",
    fontWeight: "600",
  },
  chevronContainer: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#f1f5f9',
    justifyContent: 'center',
    alignItems: 'center',
  },
  chevron: {
    fontSize: 28,
    color: "#6366f1",
    fontWeight: "500",
  },
  changeButton: {
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 14,
    marginRight: 8,
  },
  changeButtonText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "800",
  },
  generateButton: {
    backgroundColor: '#06b6d4',
    borderRadius: 16,
    paddingVertical: 20,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#06b6d4",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 5,
  },
  buttonIcon: {
    fontSize: 24,
    marginBottom: 6,
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: -0.3,
  },
  buttonDisabled: {
    backgroundColor: '#cbd5e1',
    shadowColor: "#000",
    shadowOpacity: 0.1,
  },
  deleteButton: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(100, 116, 139, 0.85)',
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    elevation: 2,
    zIndex: 10,
  },
  deleteButtonText: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "400",
    lineHeight: 20,
  },
  deleteSongButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    justifyContent: "center",
    alignItems: "center",
  },
  deleteSongText: {
    color: "#fff",
    fontSize: 26,
    fontWeight: "400",
    lineHeight: 26,
  },
  durationRow: {
    flexDirection: 'row',
    gap: 10,
  },
  durationButton: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#e2e8f0',
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  durationButtonActive: {
    backgroundColor: '#6366f1',
    borderColor: '#6366f1',
    shadowColor: "#6366f1",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 4,
  },
  durationText: {
    fontSize: 18,
    fontWeight: '800',
    color: '#64748b',
  },
  durationTextActive: {
    color: '#fff',
  },
});