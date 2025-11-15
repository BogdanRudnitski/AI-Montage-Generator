import React, { useState } from "react";
import { View, Text, TouchableOpacity, Image, ScrollView, Alert, ActivityIndicator, StyleSheet, Dimensions } from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { Video, ResizeMode } from "expo-av";

const { width } = Dimensions.get('window');

export default function ExploreScreen() {
  const [mediaList, setMediaList] = useState<any[]>([]);
  const [song, setSong] = useState<{ uri: string; name: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const SERVER_URL = "http://10.121.222.165:8000";

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
      setMediaList(result.assets);
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
      }
    } catch (err) {
      console.error("Song picker error:", err);
      Alert.alert("Error", "Could not select song.");
    }
  }

  async function uploadToBackend() {
    if (!song || !song.uri) {
      return Alert.alert("Song Required", "Please select a song before uploading.");
    }

    if (mediaList.length === 0) {
      return Alert.alert("No Media", "Select some images or videos to create your project.");
    }

    const formData = new FormData();

    mediaList.forEach((item, index) => {
      formData.append("files", {
        uri: item.uri,
        name: item.filename || `file_${index}.${item.type === "video" ? "mp4" : "jpg"}`,
        type: item.type === "video" ? "video/mp4" : "image/jpeg",
      } as any);
    });

    formData.append("song", {
      uri: song.uri,
      name: song.name,
      type: "audio/mpeg",
    } as any);

    try {
      setLoading(true);

      const res = await fetch(`${SERVER_URL}/upload`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        return Alert.alert("Upload Failed", "Backend returned an error.");
      }

      const data = await res.json();
      Alert.alert(
        "✨ Success!",
        `Uploaded ${data.files_saved.length} media files and song: ${data.song_saved}`
      );
    } catch (err) {
      console.error(err);
      Alert.alert("Upload Failed", "Check your network connection.");
    } finally {
      setLoading(false);
    }
  }

  function removeMedia(index: number) {
    const newMediaList = mediaList.filter((_, i) => i !== index);
    setMediaList(newMediaList);
  }

  function renderMediaItem(item: any, index: number) {
    return (
      <View key={index} style={styles.mediaCard}>
        <View style={styles.mediaContent}>
          {item.type === "image" && (
            <Image source={{ uri: item.uri }} style={styles.mediaThumbnail} />
          )}
          {item.type === "video" && (
            <>
              <Video
                source={{ uri: item.uri }}
                useNativeControls={false}
                resizeMode={ResizeMode.COVER}
                style={styles.mediaThumbnail}
              />
              <View style={styles.playIcon}>
                <Text style={styles.playIconText}>▶</Text>
              </View>
            </>
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
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Video Editor</Text>
        <Text style={styles.headerSubtitle}>Create something amazing</Text>
      </View>

      <ScrollView 
        style={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Media Section */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>📸 Media</Text>
            <Text style={styles.sectionCount}>{mediaList.length} files</Text>
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
              <Text style={styles.emptyTitle}>Add Photos & Videos</Text>
              <Text style={styles.emptySubtitle}>Tap to select from your gallery</Text>
            </TouchableOpacity>
          ) : (
            <>
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
            </>
          )}
        </View>

        {/* Audio Section */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>🎵 Audio Track</Text>
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
                <Text style={styles.audioSubtitle}>Required for upload</Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.audioCardSelected}>
              <View style={styles.audioIconContainerSelected}>
                <Text style={styles.audioIcon}>🎵</Text>
              </View>
              <View style={styles.audioTextContainer}>
                <Text style={styles.audioTitleSelected}>{song.name}</Text>
                <Text style={styles.audioSubtitleSelected}>Tap to change</Text>
              </View>
              <TouchableOpacity onPress={pickSong} style={styles.changeButton}>
                <Text style={styles.changeButtonText}>Change</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                onPress={() => setSong(null)} 
                style={styles.deleteSongButton}
              >
                <Text style={styles.deleteSongText}>×</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Upload Section */}
        {mediaList.length > 0 && song && (
          <View style={styles.section}>
            <TouchableOpacity 
              style={styles.uploadButton}
              onPress={uploadToBackend}
              activeOpacity={0.8}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <>
                  <Text style={styles.uploadButtonIcon}>🚀</Text>
                  <Text style={styles.uploadButtonText}>Create Video</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f8f9fa",
  },
  header: {
    backgroundColor: "#667eea",
    paddingTop: 60,
    paddingBottom: 30,
    paddingHorizontal: 24,
  },
  headerTitle: {
    fontSize: 32,
    fontWeight: "800",
    color: "#fff",
    marginBottom: 4,
  },
  headerSubtitle: {
    fontSize: 16,
    color: "rgba(255, 255, 255, 0.9)",
    fontWeight: "500",
  },
  content: {
    flex: 1,
  },
  section: {
    paddingHorizontal: 24,
    marginTop: 24,
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#1a1a1a",
  },
  sectionCount: {
    fontSize: 14,
    fontWeight: "600",
    color: "#8e8e93",
  },
  emptyCard: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 40,
    alignItems: "center",
    borderWidth: 2,
    borderColor: "#e5e5ea",
    borderStyle: "dashed",
  },
  emptyIconContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "#f5f5f7",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 16,
  },
  emptyIcon: {
    fontSize: 40,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1a1a1a",
    marginBottom: 6,
  },
  emptySubtitle: {
    fontSize: 14,
    color: "#8e8e93",
    fontWeight: "500",
  },
  mediaGrid: {
    paddingVertical: 8,
  },
  mediaCard: {
    marginRight: 12,
    borderRadius: 16,
    backgroundColor: "#fff",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
    overflow: "hidden",
  },
  mediaContent: {
    position: "relative",
  },
  mediaThumbnail: {
    width: 160,
    height: 220,
    backgroundColor: "#e5e5ea",
  },
  playIcon: {
    position: "absolute",
    top: "50%",
    left: "50%",
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    justifyContent: "center",
    alignItems: "center",
    transform: [{ translateX: -24 }, { translateY: -24 }],
  },
  playIconText: {
    color: "#fff",
    fontSize: 20,
    marginLeft: 4,
  },
  mediaTypeTag: {
    position: "absolute",
    top: 8,
    right: 8,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
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
    width: 160,
    height: 220,
    borderRadius: 16,
    backgroundColor: "#fff",
    borderWidth: 2,
    borderColor: "#e5e5ea",
    borderStyle: "dashed",
    justifyContent: "center",
    alignItems: "center",
  },
  addMoreIcon: {
    fontSize: 40,
    color: "#667eea",
    marginBottom: 8,
  },
  addMoreText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#667eea",
  },
  audioCard: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 20,
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 2,
    borderColor: "#e5e5ea",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  audioCardSelected: {
    backgroundColor: "#667eea",
    borderRadius: 16,
    padding: 20,
    flexDirection: "row",
    alignItems: "center",
    shadowColor: "#667eea",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 4,
  },
  audioIconContainer: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#f5f5f7",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 16,
  },
  audioIconContainerSelected: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 16,
  },
  audioIcon: {
    fontSize: 28,
  },
  audioTextContainer: {
    flex: 1,
  },
  audioTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#1a1a1a",
    marginBottom: 4,
  },
  audioTitleSelected: {
    fontSize: 16,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 4,
  },
  audioSubtitle: {
    fontSize: 13,
    color: "#8e8e93",
    fontWeight: "500",
  },
  audioSubtitleSelected: {
    fontSize: 13,
    color: "rgba(255, 255, 255, 0.8)",
    fontWeight: "500",
  },
  chevron: {
    fontSize: 32,
    color: "#c7c7cc",
    fontWeight: "300",
  },
  changeButton: {
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 12,
  },
  changeButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
  uploadButton: {
    backgroundColor: "#f5576c",
    borderRadius: 16,
    paddingVertical: 20,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#f5576c",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 4,
  },
  uploadButtonIcon: {
    fontSize: 20,
    marginRight: 8,
  },
  uploadButtonText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  deleteButton: {
    position: "absolute",
    top: 8,
    left: 8,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    justifyContent: "center",
    alignItems: "center",
  },
  deleteButtonText: {
    color: "#fff",
    fontSize: 24,
    fontWeight: "300",
    lineHeight: 24,
  },
  deleteSongButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 8,
  },
  deleteSongText: {
    color: "#fff",
    fontSize: 24,
    fontWeight: "300",
    lineHeight: 24,
  },
});