import React, { useState, useEffect } from "react";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { Video, ResizeMode } from "expo-av";
import { View, Text, TouchableOpacity, Image, ScrollView, Alert, ActivityIndicator, Switch } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import Slider from '@react-native-community/slider';

import { styles } from "./indexStyles";

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

  const SERVER_URL = "http://192.168.68.107:8000";

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

  async function uploadMediaInParallel(files: MediaItem[], startIdx: number) {
    const BATCH_SIZE = 3; // Upload 3 files at a time
    
    // Process files in batches
    for (let batchStart = 0; batchStart < files.length; batchStart += BATCH_SIZE) {
      const batch = files.slice(batchStart, batchStart + BATCH_SIZE);
      const batchStartIdx = startIdx + batchStart;
      
      // Mark batch files as uploading
      setMediaList(prev => prev.map((item, idx) => 
        idx >= batchStartIdx && idx < batchStartIdx + batch.length 
          ? { ...item, uploading: true } 
          : item
      ));

      // Upload batch in parallel
      const batchPromises = batch.map(async (file, i) => {
        const actualIndex = batchStartIdx + i;
        const success = await uploadSingleFile(file, batchStart + i);
        
        // Update individual file status
        setMediaList(prev => prev.map((item, idx) => 
          idx === actualIndex 
            ? { ...item, uploading: false, uploaded: success } 
            : item
        ));

        if (!success) {
          Alert.alert("Upload Failed", `Failed to upload ${file.filename}`);
        }

        return { success, index: actualIndex };
      });

      // Wait for current batch to complete before starting next batch
      await Promise.all(batchPromises);
    }
  }

  async function pickMedia() {
    const { granted } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!granted) {
      Alert.alert("Permission Required", "We need access to your gallery to select media.");
      return;
    }

    // Show helper alert for large selections
    if (mediaList.length === 0) {
      Alert.alert(
        "📸 Selecting Media",
        "Native picker works best with 5-7 files at a time. For more files, use 'Add More' button after each selection.",
        [{ text: "Got it!", style: "default" }]
      );
    }

    console.log("Opening image picker...");
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      selectionLimit: 0, // No limit - let users try
      quality: 0.7, // Reduced quality for faster processing
      videoMaxDuration: 180, // 3 min max to avoid huge files
      exif: false,
      base64: false,
    });

    console.log("Picker returned:", result.canceled ? "canceled" : `${result.assets?.length || 0} files`);

    if (!result.canceled && result.assets && result.assets.length > 0) {
      const newFiles = result.assets.map((asset, index) => ({
        uri: asset.uri,
        filename: asset.fileName || `file_${Date.now()}_${index}.${asset.type === "video" ? "mp4" : "jpg"}`,
        type: asset.type as "image" | "video",
        uploading: false,
        uploaded: false,
      }));

      console.log(`Processing ${newFiles.length} files...`);

      const shouldAppend = mediaList.length > 0;
      
      if (shouldAppend) {
        const startIndex = mediaList.length;
        setMediaList(prev => [...prev, ...newFiles]);
        // Upload in batches
        uploadMediaInParallel(newFiles, startIndex);
      } else {
        try {
          await fetch(`${SERVER_URL}/clear-uploads`, {
            method: "POST",
          });
        } catch (err) {
          console.error("Failed to clear uploads:", err);
        }
        setMediaList(newFiles);
        // Upload in batches
        uploadMediaInParallel(newFiles, 0);
      }
    } else if (!result.canceled && result.assets?.length === 0) {
      Alert.alert(
        "No files selected",
        "The picker closed without selecting files. This can happen when selecting many large videos. Try selecting fewer files (5-7) at a time.",
        [{ text: "OK" }]
      );
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
    formData.append("sync_to_grid", syncToGrid.toString());

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
    low: { label: 'Low', desc: '~30 cuts', emoji: '🌙' },
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
                <Text style={styles.emptyHintText}>💡 Tip: Select 5-7 files per batch for best results</Text>
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