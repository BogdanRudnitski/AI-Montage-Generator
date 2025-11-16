import React, { useState, useEffect } from "react";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { Video, ResizeMode } from "expo-av";
import { View, Text, TouchableOpacity, Image, ScrollView, Alert, ActivityIndicator, StyleSheet, Dimensions, Switch } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import Slider from '@react-native-community/slider';

const { width } = Dimensions.get('window');

interface MediaItem {
  uri: string;
  filename?: string;
  type: "image" | "video";
  uploading?: boolean;
  uploaded?: boolean;
}

export default function ExploreScreen() {
  const router = useRouter();
  const [mediaList, setMediaList] = useState<MediaItem[]>([]);
  const [song, setSong] = useState<{ uri: string; name: string } | null>(null);
  const [songUploading, setSongUploading] = useState(false);
  const [songUploaded, setSongUploaded] = useState(false);
  const [generateLoading, setGenerateLoading] = useState(false);
  const [duration, setDuration] = useState<number>(30);
  const [syncToGrid, setSyncToGrid] = useState(false);
  
  // Advanced options
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [focusBass, setFocusBass] = useState(true);
  const [focusVocals, setFocusVocals] = useState(true);
  const [focusRepetitions, setFocusRepetitions] = useState(true);
  const [density, setDensity] = useState<'low' | 'medium' | 'high' | 'insane'>('medium');
  const [aggressiveness, setAggressiveness] = useState(0.7);

  const SERVER_URL = "http://10.122.245.118:8000";

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
      
      setMediaList(prev => prev.map((item, idx) => 
        idx === actualIndex ? { ...item, uploading: true } : item
      ));

      const success = await uploadSingleFile(files[i], i);

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

      const shouldAppend = mediaList.length > 0;
      
      if (shouldAppend) {
        const startIndex = mediaList.length;
        setMediaList(prev => [...prev, ...newFiles]);
        uploadMediaSequentially(newFiles, startIndex);
      } else {
        try {
          await fetch(`${SERVER_URL}/clear-uploads`, {
            method: "POST",
          });
        } catch (err) {
          console.error("Failed to clear uploads:", err);
        }
        setMediaList(newFiles);
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
    formData.append("density", density);
    formData.append("aggressiveness", aggressiveness.toString());
    formData.append("focus_bass", focusBass.toString());
    formData.append("focus_vocals", focusVocals.toString());
    formData.append("focus_repetitions", focusRepetitions.toString());
    formData.append("sync_to_grid", syncToGrid.toString()); // ← ADD THIS LINE

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

  // Auto-upload song when settings change
  useEffect(() => {
    if (song && !songUploading && !songUploaded) {
      uploadSongFile();
    }
  }, [song, duration, density, aggressiveness, focusBass, focusVocals, focusRepetitions, syncToGrid]);

  async function generateVideo() {
    try {
      router.replace("/loading");
      
      const res = await fetch(`${SERVER_URL}/run_ai`, {
        method: "POST",
      });
    } catch (err) {
      console.error(err);
      Alert.alert("Generation Failed", "Check your network connection.");
      router.replace("/");
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

  const densityLabels = {
    low: { label: 'Low', desc: '~30 cuts', emoji: '🐌' },
    medium: { label: 'Medium', desc: '~60 cuts', emoji: '🚶' },
    high: { label: 'High', desc: '~90 cuts', emoji: '🏃' },
    insane: { label: 'Insane', desc: '~150 cuts', emoji: '🚀' }
  };

  return (
    <View style={styles.container}>
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
                  setSongUploaded(false);
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

        {/* Advanced Options Section */}
        <View style={styles.section}>
          <TouchableOpacity
            style={styles.advancedToggle}
            onPress={() => setShowAdvanced(!showAdvanced)}
            activeOpacity={0.7}
          >
            <View style={styles.advancedToggleLeft}>
              <Ionicons 
                name="options-outline" 
                size={22} 
                color="#6366f1" 
              />
              <Text style={styles.advancedToggleText}>Advanced Options</Text>
            </View>
            <Ionicons 
              name={showAdvanced ? "chevron-up" : "chevron-down"} 
              size={24} 
              color="#94a3b8" 
            />
          </TouchableOpacity>

          {showAdvanced && (
            <View style={styles.advancedContent}>
              <Text style={styles.advancedDescription}>
                Fine-tune how the AI analyzes your music and generates cuts
              </Text>

              {/* Density Selector */}
              <View style={styles.densitySection}>
                <View style={styles.densityHeader}>
                  <Text style={styles.densityTitle}>✂️ Cut Density</Text>
                  <View style={styles.densityBadge}>
                    <Text style={styles.densityBadgeText}>
                      {densityLabels[density].emoji} {densityLabels[density].label}
                    </Text>
                  </View>
                </View>
                <Text style={styles.densityDescription}>
                  {densityLabels[density].desc} for {duration}s video
                </Text>
                
                <View style={styles.densityGrid}>
                  {(Object.keys(densityLabels) as Array<keyof typeof densityLabels>).map((key) => (
                    <TouchableOpacity
                      key={key}
                      style={[
                        styles.densityOption,
                        density === key && styles.densityOptionActive
                      ]}
                      onPress={() => {
                        setDensity(key);
                        setSongUploaded(false);
                      }}
                      activeOpacity={0.7}
                    >
                      <Text style={[
                        styles.densityEmoji,
                        density === key && styles.densityEmojiActive
                      ]}>
                        {densityLabels[key].emoji}
                      </Text>
                      <Text style={[
                        styles.densityLabel,
                        density === key && styles.densityLabelActive
                      ]}>
                        {densityLabels[key].label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* Aggressiveness Slider */}
              <View style={styles.sliderSection}>
                <View style={styles.sliderHeader}>
                  <Text style={styles.sliderTitle}>⚡ Aggressiveness</Text>
                  <View style={styles.sliderValueBadge}>
                    <Text style={styles.sliderValueText}>
                      {Math.round(aggressiveness * 100)}%
                    </Text>
                  </View>
                </View>
                <Text style={styles.sliderDescription}>
                  Higher = more cuts on subtle beats
                </Text>
                
                <View style={styles.sliderContainer}>
                  <Text style={styles.sliderMinLabel}>🐢 Chill</Text>
                  <Slider
                    style={styles.slider}
                    minimumValue={0}
                    maximumValue={1}
                    step={0.1}
                    value={aggressiveness}
                    onValueChange={(value) => {
                      setAggressiveness(value);
                      setSongUploaded(false);
                    }}
                    minimumTrackTintColor="#6366f1"
                    maximumTrackTintColor="#e2e8f0"
                    thumbTintColor="#6366f1"
                  />
                  <Text style={styles.sliderMaxLabel}>🔥 Wild</Text>
                </View>
              </View>

              {/* Focus Toggles */}
              <View style={styles.focusSection}>
                <Text style={styles.focusTitle}>🎯 Detection Focus</Text>
                
                <View style={styles.optionRow}>
                  <View style={styles.optionLeft}>
                    <Text style={styles.optionIcon}>🎢</Text>
                    <View>
                      <Text style={styles.optionTitle}>Bass Drops</Text>
                      <Text style={styles.optionDescription}>Heavy bass & drops</Text>
                    </View>
                  </View>
                  <Switch
                    value={focusBass}
                    onValueChange={(val) => {
                      setFocusBass(val);
                      setSongUploaded(false);
                    }}
                    trackColor={{ false: "#e2e8f0", true: "#93c5fd" }}
                    thumbColor={focusBass ? "#6366f1" : "#cbd5e1"}
                  />
                </View>

                <View style={styles.optionRow}>
                  <View style={styles.optionLeft}>
                    <Text style={styles.optionIcon}>🎤</Text>
                    <View>
                      <Text style={styles.optionTitle}>Vocal Hits</Text>
                      <Text style={styles.optionDescription}>Consonants & syllables</Text>
                    </View>
                  </View>
                  <Switch
                    value={focusVocals}
                    onValueChange={(val) => {
                      setFocusVocals(val);
                      setSongUploaded(false);
                    }}
                    trackColor={{ false: "#e2e8f0", true: "#93c5fd" }}
                    thumbColor={focusVocals ? "#6366f1" : "#cbd5e1"}
                  />
                </View>

                <View style={styles.optionRow}>
                  <View style={styles.optionLeft}>
                    <Text style={styles.optionIcon}>🔁</Text>
                    <View>
                      <Text style={styles.optionTitle}>Repetitions</Text>
                      <Text style={styles.optionDescription}>Repeated words/sounds</Text>
                    </View>
                  </View>
                  <Switch
                    value={focusRepetitions}
                    onValueChange={(val) => {
                      setFocusRepetitions(val);
                      setSongUploaded(false);
                    }}
                    trackColor={{ false: "#e2e8f0", true: "#93c5fd" }}
                    thumbColor={focusRepetitions ? "#6366f1" : "#cbd5e1"}
                  />
                </View>
              </View>

              <View style={styles.optionRow}>
                <View style={styles.optionLeft}>
                  <Text style={styles.optionIcon}>🎯</Text>
                  <View>
                    <Text style={styles.optionTitle}>Sync to Beat Grid</Text>
                    <Text style={styles.optionDescription}>Snap cuts to nearest beat</Text>
                  </View>
                </View>
                <Switch
                  value={syncToGrid}
                  onValueChange={(val) => {
                    setSyncToGrid(val);
                    setSongUploaded(false);
                  }}
                  trackColor={{ false: "#e2e8f0", true: "#93c5fd" }}
                  thumbColor={syncToGrid ? "#6366f1" : "#cbd5e1"}
                />
              </View>

              <View style={styles.advancedHint}>
                <Ionicons name="information-circle" size={16} color="#6366f1" />
                <Text style={styles.advancedHintText}>
                  Tip: Start with Medium density and 70% aggressiveness, then adjust to taste
                </Text>
              </View>
            </View>
          )}
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
  deleteButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(239, 68, 68, 0.95)',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: "#ef4444",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 3,
  },
  deleteButtonText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 22,
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
    fontSize: 14,
    color: "#64748b",
    fontWeight: "600",
  },
  audioSubtitleSelected: {
    fontSize: 14,
    color: "rgba(255, 255, 255, 0.9)",
    fontWeight: "600",
  },
  chevronContainer: {
    marginLeft: 8,
  },
  chevron: {
    fontSize: 32,
    color: "#cbd5e1",
    fontWeight: "300",
  },
  changeButton: {
    backgroundColor: "rgba(255, 255, 255, 0.25)",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 12,
    marginLeft: 8,
  },
  changeButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
  deleteSongButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(239, 68, 68, 0.9)",
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 8,
  },
  deleteSongText: {
    color: "#fff",
    fontSize: 24,
    fontWeight: "700",
    lineHeight: 26,
  },
  durationRow: {
    flexDirection: "row",
    gap: 12,
  },
  durationButton: {
    flex: 1,
    backgroundColor: "#fff",
    paddingVertical: 18,
    borderRadius: 16,
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  durationButtonActive: {
    backgroundColor: "#6366f1",
    shadowColor: "#6366f1",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 4,
  },
  durationText: {
    fontSize: 18,
    fontWeight: "800",
    color: "#475569",
  },
  durationTextActive: {
    color: "#fff",
  },
  advancedToggle: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 18,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  advancedToggleLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  advancedToggleText: {
    fontSize: 17,
    fontWeight: "700",
    color: "#0f172a",
  },
  advancedContent: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 20,
    marginTop: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  advancedDescription: {
    fontSize: 14,
    color: "#64748b",
    fontWeight: "600",
    marginBottom: 20,
    lineHeight: 20,
  },
  densitySection: {
    marginBottom: 24,
    paddingBottom: 24,
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
  },
  densityHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  densityTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#0f172a",
  },
  densityBadge: {
    backgroundColor: "#eef2ff",
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 10,
  },
  densityBadgeText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#6366f1",
  },
  densityDescription: {
    fontSize: 13,
    color: "#64748b",
    fontWeight: "600",
    marginBottom: 14,
  },
  densityGrid: {
    flexDirection: "row",
    gap: 10,
  },
  densityOption: {
    flex: 1,
    backgroundColor: "#f8f9fa",
    paddingVertical: 14,
    paddingHorizontal: 8,
    borderRadius: 12,
    alignItems: "center",
    borderWidth: 2,
    borderColor: "transparent",
  },
  densityOptionActive: {
    backgroundColor: "#eef2ff",
    borderColor: "#6366f1",
  },
  densityEmoji: {
    fontSize: 24,
    marginBottom: 6,
    opacity: 0.5,
  },
  densityEmojiActive: {
    opacity: 1,
  },
  densityLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: "#64748b",
  },
  densityLabelActive: {
    color: "#6366f1",
  },
  sliderSection: {
    marginBottom: 24,
    paddingBottom: 24,
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
  },
  sliderHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  sliderTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#0f172a",
  },
  sliderValueBadge: {
    backgroundColor: "#eef2ff",
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 10,
    minWidth: 50,
    alignItems: "center",
  },
  sliderValueText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#6366f1",
  },
  sliderDescription: {
    fontSize: 13,
    color: "#64748b",
    fontWeight: "600",
    marginBottom: 14,
  },
  sliderContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  slider: {
    flex: 1,
    height: 40,
  },
  sliderMinLabel: {
    fontSize: 18,
  },
  sliderMaxLabel: {
    fontSize: 18,
  },
  focusSection: {
    marginBottom: 0,
  },
  focusTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#0f172a",
    marginBottom: 12,
  },
  optionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
  },
  optionLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    flex: 1,
  },
  optionIcon: {
    fontSize: 28,
  },
  optionTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#0f172a",
    marginBottom: 2,
  },
  optionDescription: {
    fontSize: 13,
    color: "#64748b",
    fontWeight: "600",
  },
  advancedHint: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#eef2ff",
    padding: 14,
    borderRadius: 12,
    marginTop: 16,
  },
  advancedHintText: {
    fontSize: 12,
    color: "#6366f1",
    fontWeight: "600",
    flex: 1,
    lineHeight: 18,
  },
  generateButton: {
    backgroundColor: "#6366f1",
    paddingVertical: 20,
    borderRadius: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    shadowColor: "#6366f1",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 8,
  },
  buttonDisabled: {
    backgroundColor: "#cbd5e1",
    shadowColor: "#000",
    shadowOpacity: 0.1,
  },
  buttonIcon: {
    fontSize: 24,
  },
  buttonText: {
    fontSize: 19,
    fontWeight: "900",
    color: "#fff",
    letterSpacing: -0.3,
  },
});