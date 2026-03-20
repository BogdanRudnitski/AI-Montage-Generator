import React, { useState, useEffect, useRef, useCallback } from "react";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { Video, ResizeMode } from "expo-av";
import { View, Text, TouchableOpacity, Image, ScrollView, Alert, ActivityIndicator, StyleSheet, Dimensions, Switch, Modal, FlatList, TextInput, KeyboardAvoidingView, Platform } from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import Slider from '@react-native-community/slider';
import { SERVER_URL } from "../config";
import { useAnalyze } from "../context/AnalyzeContext";
import { getSavedTracks, addTrackToLibrary, removeTrackFromLibrary, type SavedTrack } from "../lib/musicLibrary";
import { SongRangePickerModal } from "../components/SongRangePickerModal";

const { width } = Dimensions.get("window");
const ART_SQUARE_SIZE = 120;
// Keep demo buttons in the codebase, but ship them inaccessible by default.
const DEMO_ENABLED = false;

/** Base64 encode byte array (chunked for large embedded art). */
function bytesToBase64(bytes: number[]): string {
  if (typeof btoa === "undefined") return "";
  const chunkSize = 8192;
  let out = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.slice(i, i + chunkSize);
    out += btoa(String.fromCharCode(...chunk));
  }
  return out;
}

/** Try to extract embedded cover art from MP3; on success set nameTrackArtUri to data URL. */
function tryExtractMp3Art(uri: string, setArt: (dataUrl: string | null) => void) {
  (async () => {
    try {
      const res = await fetch(uri, { method: "GET" });
      const ab = await res.arrayBuffer();
      const arr = Array.from(new Uint8Array(ab));
      const jsmediatags = require("jsmediatags");
      jsmediatags.read(arr, {
        onSuccess: (tag: { tags?: { picture?: { data: number[]; format: string } } }) => {
          const pic = tag.tags?.picture;
          if (!pic?.data?.length) return;
          const format = (pic.format || "image/jpeg").toLowerCase().replace(/^image\//, "") || "jpeg";
          const b64 = bytesToBase64(pic.data);
          setArt(`data:image/${format};base64,${b64}`);
        },
        onError: () => {},
      });
    } catch {
      // ignore
    }
  })();
}

interface MediaItem {
  uri: string;
  filename?: string;
  serverFilename?: string;
  type: "image" | "video";
  uploading?: boolean;
  uploaded?: boolean;
}

export default function ExploreScreen() {
  const router = useRouter();
  const { setAnalyzeResult, setMediaListForPreview, setSongUri } = useAnalyze();
  const [mediaList, setMediaList] = useState<MediaItem[]>([]);
  const [song, setSong] = useState<{ uri: string; name: string } | null>(null);
  const [songUploading, setSongUploading] = useState(false);
  const [songUploaded, setSongUploaded] = useState(false);
  const [generateLoading, setGenerateLoading] = useState(false);
  const [duration, setDuration] = useState<number>(30);
  /** Start time (seconds) in the full track for the analysis window; must match backend/options. */
  const [songStartSec, setSongStartSec] = useState(0);
  const [showSongRangeModal, setShowSongRangeModal] = useState(false);
  const [syncToGrid, setSyncToGrid] = useState(false);
  
  // Advanced options
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [focusBass, setFocusBass] = useState(true);
  const [focusVocals, setFocusVocals] = useState(true);
  const [focusRepetitions, setFocusRepetitions] = useState(true);
  const [density, setDensity] = useState<'low' | 'medium' | 'high'>('medium');
  const [aggressiveness, setAggressiveness] = useState(0.7);
  const [tapMode, setTapMode] = useState<null | "verbatim" | "calibrate">(null);
  const [songTapCount, setSongTapCount] = useState<number>(0);
  const [calibrating, setCalibrating] = useState(false);
  const [calibrationDone, setCalibrationDone] = useState(false);
  const calibrationSentForSongRef = useRef<string | null>(null);

  const [showMusicModal, setShowMusicModal] = useState(false);
  const [savedTracks, setSavedTracks] = useState<SavedTrack[]>([]);
  const [musicPickerOpening, setMusicPickerOpening] = useState(false);
  const [nameTrackModal, setNameTrackModal] = useState<{ uri: string; defaultName: string } | null>(null);
  const [nameTrackValue, setNameTrackValue] = useState("");
  const [nameTrackSinger, setNameTrackSinger] = useState("");
  const [nameTrackArtUri, setNameTrackArtUri] = useState<string | null>(null);
  const [savingTrack, setSavingTrack] = useState(false);

  // Check if all media and song are uploaded
  const allUploaded = mediaList.length > 0 && 
                      mediaList.every(m => m.uploaded) && 
                      song !== null && 
                      songUploaded;

  const uiLocked = generateLoading;

  // When analysis starts, lock editing so the request + resulting preview
  // can't drift due to mid-request UI changes.
  useEffect(() => {
    if (!uiLocked) return;
    setShowMusicModal(false);
    setNameTrackModal(null);
    setMusicPickerOpening(false);
    setSavingTrack(false);
  }, [uiLocked]);

  // Session upload: always re-upload selected videos (deduplicate=false). Backend returns stable_id.mp4.
  async function uploadSingleFile(file: MediaItem, index: number): Promise<{ success: boolean; serverFilename?: string }> {
    const formData = new FormData();
    const name = file.filename || `file_${index}.${file.type === "video" ? "mp4" : "jpg"}`;
    formData.append("files", {
      uri: file.uri,
      name,
      type: file.type === "video" ? "video/mp4" : "image/jpeg",
    } as any);
    formData.append("deduplicate", "false"); // Homepage: always save; backend normalizes to MP4 + stable ID

    try {
      const res = await fetch(`${SERVER_URL}/upload-single`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error("Upload failed");
      const data = await res.json();
      const serverFilename = data.files_saved?.[0];
      return { success: true, serverFilename };
    } catch (err) {
      console.error("Upload error:", err);
      return { success: false };
    }
  }

  async function uploadMediaInParallel(files: MediaItem[], startIdx: number) {
    // Mark all files as uploading
    setMediaList(prev => prev.map((item, idx) => 
      idx >= startIdx && idx < startIdx + files.length 
        ? { ...item, uploading: true } 
        : item
    ));

    // Upload all files in parallel
    const uploadPromises = files.map(async (file, i) => {
      const actualIndex = startIdx + i;
      const result = await uploadSingleFile(file, i);
      setMediaList(prev => prev.map((item, idx) =>
        idx === actualIndex
          ? { ...item, uploading: false, uploaded: result.success, ...(result.serverFilename && { serverFilename: result.serverFilename }) }
          : item
      ));
      if (!result.success) Alert.alert("Upload Failed", `Failed to upload ${file.filename}`);
      return { success: result.success, index: actualIndex };
    });

    // Wait for all uploads to complete
    await Promise.all(uploadPromises);
  }

  async function pickMedia() {
    if (uiLocked) return;
    const { granted } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!granted) {
      Alert.alert("Permission Required", "We need access to your gallery to select media.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Videos,
      allowsMultipleSelection: true,
      selectionLimit: 0,
      quality: 1,
    });

    if (!result.canceled) {
      const newFiles = result.assets.map((asset, index) => ({
        uri: asset.uri,
        filename: asset.fileName || `video_${index}.mp4`,
        type: "video" as const,
        uploading: false,
        uploaded: false,
      }));

      // New session: clear backend media then upload all. Always re-upload for the new session.
      const isNewSession = mediaList.length === 0;
      if (isNewSession) {
        try {
          await fetch(`${SERVER_URL}/clear-uploads`, { method: "POST" });
        } catch (err) {
          console.error("Failed to clear uploads:", err);
        }
      }
      if (isNewSession) {
        setMediaList(newFiles);
        uploadMediaInParallel(newFiles, 0);
      } else {
        const startIndex = mediaList.length;
        setMediaList((prev) => [...prev, ...newFiles]);
        uploadMediaInParallel(newFiles, startIndex);
      }
    }
  }

  async function uploadSongFile() {
    if (uiLocked) return;
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
    formData.append("song_start_sec", songStartSec.toString());

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
    if (uiLocked) return;
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

  async function pickSongAndAddToLibrary() {
    if (uiLocked) return;
    if (musicPickerOpening) return;
    setMusicPickerOpening(true);
    setShowMusicModal(false);
    // Let the modal close before opening the document picker (avoids picker not showing / crashes)
    await new Promise((r) => setTimeout(r, 400));
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "audio/*",
        copyToCacheDirectory: true,
      });
      if (!result.canceled && result.assets?.length) {
        const asset = result.assets[0];
        const defaultName = asset.name || "song.mp3";
        setNameTrackValue(defaultName);
        setNameTrackSinger("");
        setNameTrackArtUri(null);
        setNameTrackModal({ uri: asset.uri, defaultName });
        tryExtractMp3Art(asset.uri, setNameTrackArtUri);
      }
    } catch (err) {
      console.error(err);
      Alert.alert("Error", "Could not open file picker or save song.");
    } finally {
      setMusicPickerOpening(false);
    }
  }

  async function saveNamedTrackToLibrary() {
    if (uiLocked) return;
    const pending = nameTrackModal;
    if (!pending || savingTrack) return;
    const name = nameTrackValue.trim() || pending.defaultName;
    const artist = nameTrackSinger.trim() || undefined;
    setSavingTrack(true);
    try {
      const track = await addTrackToLibrary(
        pending.uri,
        name,
        nameTrackArtUri ?? undefined,
        artist
      );
      setSong({ uri: track.uri, name: track.name });
      setSavedTracks((prev) => [...prev, track]);
      setSongUploaded(false);
      setNameTrackModal(null);
      setNameTrackArtUri(null);
      setNameTrackSinger("");
    } catch (err) {
      console.warn("Could not copy to library, using file as-is:", err);
      setSong({ uri: pending.uri, name });
      setSavedTracks((prev) => [...prev, { id: `temp_${Date.now()}`, name, artist, uri: pending.uri }]);
      setSongUploaded(false);
      setNameTrackModal(null);
      setNameTrackArtUri(null);
      setNameTrackSinger("");
    } finally {
      setSavingTrack(false);
    }
  }

  async function pickCoverArtForTrack() {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      if (!result.canceled && result.assets?.[0]) {
        setNameTrackArtUri(result.assets[0].uri);
      }
    } catch (err) {
      console.error(err);
      Alert.alert("Error", "Could not pick image.");
    }
  }

  async function loadMusicLibrary() {
    const tracks = await getSavedTracks();
    setSavedTracks(tracks);
  }

  const fetchSongTapCount = useCallback(async () => {
    if (!song) {
      setSongTapCount(0);
      return;
    }
    try {
      const res = await fetch(`${SERVER_URL}/api/taps/${encodeURIComponent(song.name)}`);
      const data = await res.json();
      setSongTapCount(data.manual_cuts?.length ?? 0);
    } catch {
      setSongTapCount(0);
    }
  }, [song]);

  // Auto-upload song when settings change
  useEffect(() => {
    if (uiLocked) return;
    if (song && !songUploading && !songUploaded) {
      uploadSongFile();
    }
  }, [uiLocked, song, duration, songStartSec, density, aggressiveness, focusBass, focusVocals, focusRepetitions, syncToGrid]);

  useEffect(() => {
    if (showMusicModal) loadMusicLibrary();
  }, [showMusicModal]);

  useEffect(() => {
    fetchSongTapCount();
  }, [fetchSongTapCount]);

  useFocusEffect(
    useCallback(() => {
      fetchSongTapCount();
    }, [fetchSongTapCount])
  );

  useEffect(() => {
    const persistTapMode = async () => {
      try {
        await fetch(`${SERVER_URL}/api/options`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tap_mode: tapMode }),
        });
      } catch {
        // Keep UI responsive even if backend write fails.
      }
    };
    persistTapMode();
  }, [tapMode]);

  useEffect(() => {
    if (tapMode !== "calibrate") return;
    if (!song || songTapCount < 1) return;
    if (calibrationSentForSongRef.current === song.name) return;
    calibrationSentForSongRef.current = song.name;
    runCalibration();
  }, [tapMode, song, songTapCount]);

  useEffect(() => {
    if (!song) {
      calibrationSentForSongRef.current = null;
      return;
    }
    if (tapMode !== "calibrate") {
      calibrationSentForSongRef.current = null;
    }
  }, [tapMode, song?.name]);

  // Invalidate previous analysis when the user selects a different song (avoid showing Enya cuts for Kesha)
  useEffect(() => {
    // song changed
    setAnalyzeResult(null);
    setSongStartSec(0);
  }, [song?.uri]);

  async function createPreview() {
    if ((tapMode === "verbatim" || tapMode === "calibrate") && songTapCount < 1 && song) {
      Alert.alert(
        "No taps recorded",
        "Record taps for this song first, or switch to AI Analysis.",
        [
          {
            text: "Record now",
            onPress: () =>
              router.push({ pathname: "/tap-recorder", params: { songName: song.name, songUri: song.uri } }),
          },
          { text: "Cancel", style: "cancel" },
        ]
      );
      return;
    }
    setGenerateLoading(true);
    try {
      const body: Record<string, unknown> = song?.name ? { song_filename: song.name } : {};
      body.song_start_sec = songStartSec;
      // Send tap_mode explicitly so the backend never reads a stale options.json value.
      body.tap_mode = tapMode ?? null;
      console.log("[TRACE] createPreview: sending POST /analyze", {
        currentSongName: song?.name,
        currentSongUri: song?.uri,
        requestBody: body,
      });
      const res = await fetch(`${SERVER_URL}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      console.log("[TRACE] createPreview: POST /analyze response", {
        success: data.success,
        duration: data.duration,
        bpm: data.bpm,
        segmentCount: data.segments?.length ?? 0,
        firstSegmentStart: data.segments?.[0]?.startTime,
        firstCutTime: data.cut_points?.[0],
      });
      if (!data.success) {
        Alert.alert("Analyze Failed", data.error || "Unknown error");
        return;
      }
      setAnalyzeResult({
        duration: data.duration,
        max_duration: data.max_duration,
        bpm: data.bpm,
        cut_points: data.cut_points || [],
        segments: data.segments || [],
        song_start_sec: songStartSec,
      });
      setMediaListForPreview(
        mediaList.map((m) => ({
          uri: m.uri,
          filename: m.serverFilename || m.filename,
        }))
      );
      setSongUri(song?.uri ?? null);
      router.replace("/preview");
    } catch (err) {
      console.error(err);
      Alert.alert("Analyze Failed", "Check your network connection.");
    } finally {
      setGenerateLoading(false);
    }
  }

  /** Decoy preview: fixed cut lengths 1, 2, 3, 4, 3, 2, 1 seconds. No backend. Use to verify segment cutting. */
  function openDecoyPreview() {
    if (uiLocked) return;
    const videoItems = mediaList.filter((m) => m.type === "video");
    if (videoItems.length === 0) {
      Alert.alert("Need at least one video", "Add video clips to test the preview.");
      return;
    }
    const segmentDurations = [1, 2, 3, 4, 3, 2, 1];
    let t = 0;
    const segments = segmentDurations.map((dur, i) => {
      const startTime = t;
      t += dur;
      const clipIndex = i % videoItems.length;
      const filename = videoItems[clipIndex].serverFilename || videoItems[clipIndex].filename || `clip_${clipIndex}.mp4`;
      return {
        startTime,
        endTime: t,
        clipFilename: filename,
        clipStart: 0,
        clipEnd: dur,
      };
    });
    const totalDuration = t;
    setAnalyzeResult({
      duration: totalDuration,
      max_duration: totalDuration,
      bpm: 0,
      cut_points: [],
      segments,
      song_start_sec: 0,
    });
    setMediaListForPreview(
      mediaList.map((m) => ({
        uri: m.uri,
        filename: m.serverFilename || m.filename,
      }))
    );
    setSongUri(song?.uri ?? null);
    router.replace("/preview");
  }

  function removeMedia(index: number) {
    if (uiLocked) return;
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
                  <Text style={styles.queuedText}>Queued</Text>
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
            VIDEO
          </Text>
        </View>
        <TouchableOpacity 
          style={styles.deleteButton}
          onPress={() => removeMedia(index)}
          activeOpacity={0.7}
          disabled={uiLocked}
        >
          <Text style={styles.deleteButtonText}>×</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const densityLabels = {
    low: { label: "Low", desc: "~30 cuts" },
    medium: { label: "Medium", desc: "~60 cuts" },
    high: { label: "High", desc: "~90 cuts" },
  };

  async function runCalibration() {
    if (!song || calibrating) return;
    setCalibrating(true);
    setCalibrationDone(false);
    try {
      const res = await fetch(`${SERVER_URL}/api/calibrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ song_filename: song.name }),
      });
      const data = await res.json();
      if (!data.success) {
        Alert.alert("Calibration failed", data.error || "Unknown error");
        return;
      }
      setCalibrationDone(true);
      Alert.alert("Calibration complete", "Tap-driven calibration finished.");
    } catch {
      Alert.alert("Calibration failed", "Please try again.");
    } finally {
      setCalibrating(false);
    }
  }

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
                <Ionicons name="camera" size={22} color="#6366f1" />
              </View>
              <View>
                <Text style={styles.sectionTitle}>Media Gallery</Text>
                <Text style={styles.sectionSubtitle}>Videos</Text>
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
              disabled={uiLocked}
            >
              <View style={styles.emptyIconContainer}>
                <Ionicons name="add-circle-outline" size={28} color="#6366f1" />
              </View>
              <Text style={styles.emptyTitle}>Add Your Media</Text>
              <Text style={styles.emptySubtitle}>Tap to select videos</Text>
              <View style={styles.emptyHint}>
                <Text style={styles.emptyHintText}>Uploads</Text>
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
                disabled={uiLocked}
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
                <Ionicons name="musical-notes" size={22} color="#6366f1" />
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
              onPress={() => setShowMusicModal(true)}
              activeOpacity={0.7}
              disabled={uiLocked}
            >
              <View style={styles.audioIconContainer}>
                <Ionicons name="musical-notes" size={22} color="#fff" />
              </View>
              <View style={styles.audioTextContainer}>
                <Text style={styles.audioTitle}>Select Background Music</Text>
                <Text style={styles.audioSubtitle}>My music or upload new • MP3, WAV, M4A</Text>
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
              <View
                style={[
                  styles.audioIconContainerSelected,
                  songUploaded && styles.audioIconContainerSelectedUploaded,
                ]}
              >
                {songUploading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : songUploaded ? (
                  <Ionicons name="checkmark-circle" size={28} color="#fff" />
                ) : (
                  <Ionicons name="musical-notes" size={18} color="#fff" />
                )}
              </View>
              <View style={styles.audioTextContainer}>
                <Text style={styles.audioTitleSelected} numberOfLines={1}>{song.name}</Text>
                <Text style={styles.audioSubtitleSelected}>
                  {songUploading ? "Uploading..." : songUploaded ? "Ready to create" : "Waiting..."}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setShowMusicModal(true)}
                style={styles.changeButton}
                disabled={uiLocked}
              >
                <Text style={styles.changeButtonText}>Change</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  setSong(null);
                  setSongUploaded(false);
                }}
                style={styles.deleteSongButton}
                disabled={uiLocked}
              >
                <Text style={styles.deleteSongText}>×</Text>
              </TouchableOpacity>
            </View>
          )}

          <Modal visible={showMusicModal} transparent animationType="fade">
            <TouchableOpacity
              style={styles.musicModalBackdrop}
              activeOpacity={1}
              onPress={() => {
                if (uiLocked) return;
                setShowMusicModal(false);
              }}
              disabled={uiLocked}
            >
              <View style={styles.musicModalContent} onStartShouldSetResponder={() => true}>
                <Text style={styles.musicModalTitle}>Select music</Text>
                <Text style={styles.musicModalSubtitle}>Pick from your library or upload a new track</Text>
                <FlatList
                  data={savedTracks}
                  keyExtractor={(t) => t.id}
                  style={styles.musicModalList}
                  renderItem={({ item }) => (
                    <View style={styles.musicModalRow}>
                      <TouchableOpacity
                        style={styles.musicModalRowTouch}
                        onPress={() => {
                          if (uiLocked) return;
                          setSong({ uri: item.uri, name: item.name });
                          setSongUploaded(false);
                          setShowMusicModal(false);
                        }}
                        disabled={uiLocked}
                      >
                        {item.artUri ? (
                          <Image source={{ uri: item.artUri }} style={styles.musicModalRowArt} />
                        ) : (
                          <View style={styles.musicModalRowArtPlaceholder}>
                            <Ionicons name="musical-notes" size={22} color="#6366f1" />
                          </View>
                        )}
                        <View style={styles.musicModalRowTextWrap}>
                          <Text style={styles.musicModalRowText} numberOfLines={1}>{item.name}</Text>
                          {item.artist ? <Text style={styles.musicModalRowArtist} numberOfLines={1}>{item.artist}</Text> : null}
                        </View>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.musicModalDeleteBtn}
                        onPress={async () => {
                          if (uiLocked) return;
                          await removeTrackFromLibrary(item.id);
                          setSavedTracks((prev) => prev.filter((t) => t.id !== item.id));
                          if (song?.uri === item.uri) {
                            setSong(null);
                            setSongUploaded(false);
                          }
                        }}
                        disabled={uiLocked}
                      >
                        <Ionicons name="trash-outline" size={22} color="#94a3b8" />
                      </TouchableOpacity>
                    </View>
                  )}
                  ListEmptyComponent={
                    <Text style={styles.musicModalEmpty}>No saved tracks yet. Tap "Upload new" to add one.</Text>
                  }
                />
                <TouchableOpacity
                  style={[styles.musicModalUploadBtn, musicPickerOpening && styles.musicModalUploadBtnDisabled]}
                  onPress={pickSongAndAddToLibrary}
                  disabled={musicPickerOpening || uiLocked}
                >
                  {musicPickerOpening ? (
                    <ActivityIndicator size="small" color="#6366f1" />
                  ) : (
                    <Ionicons name="add-circle-outline" size={24} color="#6366f1" />
                  )}
                  <Text style={styles.musicModalUploadBtnText}>{musicPickerOpening ? "Opening" : "Upload new"}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.musicModalCancel}
                  onPress={() => {
                    if (uiLocked) return;
                    setShowMusicModal(false);
                  }}
                  disabled={uiLocked}
                >
                  <Text style={styles.musicModalCancelText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          </Modal>

          {/* Name this track + optional cover art (after picking a file) */}
          <Modal visible={!!nameTrackModal} transparent animationType="fade">
            <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.nameTrackModalBackdrop}>
              <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setNameTrackModal(null)} />
              <View style={styles.nameTrackModalContent} onStartShouldSetResponder={() => true}>
                <Text style={styles.nameTrackModalTitle}>Name this track</Text>
                <Text style={styles.nameTrackModalHint}>Audio is saved to app storage and persists between sessions.</Text>
                <View style={styles.nameTrackModalBody}>
                  <TouchableOpacity style={styles.nameTrackArtSquare} onPress={pickCoverArtForTrack} activeOpacity={0.85}>
                    {nameTrackArtUri ? (
                      <>
                        <Image source={{ uri: nameTrackArtUri }} style={styles.nameTrackArtSquareImage} />
                        <View style={styles.nameTrackArtSquareOverlay}>
                          <Ionicons name="pencil" size={28} color="#fff" />
                        </View>
                      </>
                    ) : (
                      <View style={styles.nameTrackArtSquarePlaceholder}>
                        <Ionicons name="add" size={44} color="#94a3b8" />
                      </View>
                    )}
                  </TouchableOpacity>
                  <View style={styles.nameTrackFields}>
                    <View style={styles.nameTrackInputWrap}>
                      <TextInput
                        style={styles.nameTrackInputTitle}
                        value={nameTrackValue}
                        onChangeText={setNameTrackValue}
                        placeholder="Title"
                        placeholderTextColor="#94a3b8"
                        autoFocus
                      />
                      {nameTrackValue.length > 0 && (
                        <TouchableOpacity style={styles.nameTrackInputClear} onPress={() => setNameTrackValue("")} hitSlop={12}>
                          <Ionicons name="close-circle" size={22} color="#94a3b8" />
                        </TouchableOpacity>
                      )}
                    </View>
                    <View style={styles.nameTrackInputWrap}>
                      <TextInput
                        style={styles.nameTrackInput}
                        value={nameTrackSinger}
                        onChangeText={setNameTrackSinger}
                        placeholder="Singer / Artist"
                        placeholderTextColor="#94a3b8"
                      />
                      {nameTrackSinger.length > 0 && (
                        <TouchableOpacity style={styles.nameTrackInputClear} onPress={() => setNameTrackSinger("")} hitSlop={12}>
                          <Ionicons name="close-circle" size={22} color="#94a3b8" />
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                </View>
                <View style={styles.nameTrackActions}>
                  <TouchableOpacity style={styles.nameTrackCancelBtn} onPress={() => setNameTrackModal(null)}>
                    <Text style={styles.nameTrackCancelBtnText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.nameTrackSaveBtn, savingTrack && styles.musicModalUploadBtnDisabled]}
                    onPress={saveNamedTrackToLibrary}
                    disabled={savingTrack}
                  >
                    {savingTrack ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.nameTrackSaveBtnText}>Save</Text>}
                  </TouchableOpacity>
                </View>
              </View>
            </KeyboardAvoidingView>
          </Modal>
        </View>

        {song && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionTitleRow}>
                <View style={styles.sectionIconBg}>
                  <Ionicons name="finger-print" size={22} color="#6366f1" />
                </View>
                <View>
                  <Text style={styles.sectionTitle}>Cut Mode</Text>
                  <Text style={styles.sectionSubtitle}>How to detect cuts</Text>
                </View>
              </View>
            </View>

            <TouchableOpacity
              style={[styles.recordTapsButton, songTapCount > 0 ? styles.recordTapsButtonRerecord : styles.recordTapsButtonRecord]}
              onPress={() => router.push({ pathname: "/tap-recorder", params: { songName: song.name, songUri: song.uri } })}
              activeOpacity={0.8}
              disabled={uiLocked}
            >
              <Ionicons
                name={songTapCount > 0 ? "refresh-circle" : "add-circle"}
                size={20}
                color={songTapCount > 0 ? "#334155" : "#fff"}
              />
              <Text style={[styles.recordTapsButtonText, songTapCount > 0 && styles.recordTapsButtonTextRerecord]}>
                {songTapCount > 0 ? `View taps (${songTapCount})` : "Record taps"}
              </Text>
            </TouchableOpacity>

            <View style={styles.modeStack}>
              <TouchableOpacity
                activeOpacity={0.8}
                style={[
                  styles.modeCard,
                  tapMode === "verbatim" && styles.modeCardSelected,
                  songTapCount < 1 && styles.modeCardDisabled,
                ]}
                onPress={() => setTapMode("verbatim")}
                disabled={songTapCount < 1}
              >
                <View style={styles.modeCardLeft}>
                  <Ionicons name="hand-left-outline" size={22} color={songTapCount < 1 ? "#94a3b8" : "#6366f1"} />
                  <View style={styles.modeTextWrap}>
                    <Text style={[styles.modeTitle, songTapCount < 1 && styles.modeTextDisabled]}>Use My Taps</Text>
                    <Text style={[styles.modeSubtitle, songTapCount < 1 && styles.modeTextDisabled]}>
                      {songTapCount < 1 ? "Record taps first for this song" : "Use exactly where I tapped"}
                    </Text>
                  </View>
                </View>
                <Ionicons name={tapMode === "verbatim" ? "radio-button-on" : "radio-button-off"} size={20} color={songTapCount < 1 ? "#94a3b8" : "#6366f1"} />
              </TouchableOpacity>

              <TouchableOpacity
                activeOpacity={0.8}
                style={[
                  styles.modeCard,
                  tapMode === "calibrate" && styles.modeCardSelected,
                  songTapCount < 1 && styles.modeCardDisabled,
                ]}
                onPress={() => setTapMode("calibrate")}
                disabled={songTapCount < 1}
              >
                <View style={styles.modeCardLeft}>
                  <Ionicons name="locate-outline" size={22} color={songTapCount < 1 ? "#94a3b8" : "#6366f1"} />
                  <View style={styles.modeTextWrap}>
                    <Text style={[styles.modeTitle, songTapCount < 1 && styles.modeTextDisabled]}>Calibrate AI</Text>
                    <Text style={[styles.modeSubtitle, songTapCount < 1 && styles.modeTextDisabled]}>
                      {songTapCount < 1
                        ? "Record taps first for this song"
                        : calibrating
                        ? "Calibrating now..."
                        : calibrationDone
                        ? "Calibration complete"
                        : "Train AI from my taps"}
                    </Text>
                  </View>
                </View>
                {calibrating ? (
                  <ActivityIndicator size="small" color="#6366f1" />
                ) : (
                  <Ionicons name={tapMode === "calibrate" ? "radio-button-on" : "radio-button-off"} size={20} color={songTapCount < 1 ? "#94a3b8" : "#6366f1"} />
                )}
              </TouchableOpacity>

              <TouchableOpacity
                activeOpacity={0.8}
                style={[
                  styles.modeCard,
                  tapMode === null && styles.modeCardSelected,
                ]}
                onPress={() => setTapMode(null)}
              >
                <View style={styles.modeCardLeft}>
                  <Ionicons name="hardware-chip-outline" size={22} color="#6366f1" />
                  <View style={styles.modeTextWrap}>
                    <Text style={styles.modeTitle}>AI Analysis</Text>
                    <Text style={styles.modeSubtitle}>Let the AI detect cut points</Text>
                  </View>
                </View>
                <Ionicons name={tapMode === null ? "radio-button-on" : "radio-button-off"} size={20} color="#6366f1" />
              </TouchableOpacity>
            </View>

            {(tapMode === null || tapMode === "calibrate") && (
              <View style={styles.inlineAdvancedWrap}>
                <TouchableOpacity
                  style={styles.advancedToggle}
                  disabled={uiLocked}
                  onPress={() => {
                    if (uiLocked) return;
                    setShowAdvanced(!showAdvanced);
                  }}
                  activeOpacity={0.7}
                >
                  <View style={styles.advancedToggleLeft}>
                    <Ionicons name="options-outline" size={22} color="#6366f1" />
                    <Text style={styles.advancedToggleText}>Advanced Options</Text>
                  </View>
                  <Ionicons name={showAdvanced ? "chevron-up" : "chevron-down"} size={24} color="#94a3b8" />
                </TouchableOpacity>

                {showAdvanced && (
                  <View style={styles.advancedContent}>
                    <Text style={styles.advancedDescription}>Fine-tune how analysis works and generates cuts</Text>
                    <View style={styles.densitySection}>
                      <View style={styles.densityHeader}>
                        <Text style={styles.densityTitle}>Cut Density</Text>
                        <View style={styles.densityBadge}>
                          <Text style={styles.densityBadgeText}>{densityLabels[density].label}</Text>
                        </View>
                      </View>
                      <Text style={styles.densityDescription}>{densityLabels[density].desc} for {duration}s video</Text>
                      <View style={styles.densityGrid}>
                        {(Object.keys(densityLabels) as Array<keyof typeof densityLabels>).map((key) => (
                          <TouchableOpacity
                            key={key}
                            style={[styles.densityOption, density === key && styles.densityOptionActive]}
                            disabled={uiLocked}
                            onPress={() => {
                              if (uiLocked) return;
                              setDensity(key);
                              setSongUploaded(false);
                            }}
                            activeOpacity={0.7}
                          >
                            <Text style={[styles.densityLabel, density === key && styles.densityLabelActive]}>{densityLabels[key].label}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </View>

                    <View style={styles.sliderSection}>
                      <View style={styles.sliderHeader}>
                        <Text style={styles.sliderTitle}>Aggressiveness</Text>
                        <View style={styles.sliderValueBadge}>
                          <Text style={styles.sliderValueText}>{Math.round(aggressiveness * 100)}%</Text>
                        </View>
                      </View>
                      <Text style={styles.sliderDescription}>Higher = more cuts on subtle beats</Text>
                      <View style={styles.sliderContainer}>
                        <Slider
                          style={styles.slider}
                          minimumValue={0}
                          maximumValue={1}
                          step={0.1}
                          value={aggressiveness}
                          disabled={uiLocked}
                          onValueChange={(value) => {
                            if (uiLocked) return;
                            setAggressiveness(value);
                            setSongUploaded(false);
                          }}
                          minimumTrackTintColor="#6366f1"
                          maximumTrackTintColor="#e2e8f0"
                          thumbTintColor="#6366f1"
                        />
                      </View>
                    </View>

                    <View style={styles.focusSection}>
                      <Text style={styles.focusTitle}>Detection Focus</Text>
                      <View style={styles.optionRow}>
                        <View style={styles.optionLeft}>
                          <View>
                            <Text style={styles.optionTitle}>Bass Drops</Text>
                            <Text style={styles.optionDescription}>Heavy bass & drops</Text>
                          </View>
                        </View>
                        <Switch
                          value={focusBass}
                          disabled={uiLocked}
                          onValueChange={(val) => {
                            if (uiLocked) return;
                            setFocusBass(val);
                            setSongUploaded(false);
                          }}
                          trackColor={{ false: "#e2e8f0", true: "#6366f1" }}
                          thumbColor={focusBass ? "#fff" : "#cbd5e1"}
                        />
                      </View>

                      <View style={styles.optionRow}>
                        <View style={styles.optionLeft}>
                          <View>
                            <Text style={styles.optionTitle}>Vocal Hits</Text>
                            <Text style={styles.optionDescription}>Consonants & syllables</Text>
                          </View>
                        </View>
                        <Switch
                          value={focusVocals}
                          disabled={uiLocked}
                          onValueChange={(val) => {
                            if (uiLocked) return;
                            setFocusVocals(val);
                            setSongUploaded(false);
                          }}
                          trackColor={{ false: "#e2e8f0", true: "#6366f1" }}
                          thumbColor={focusVocals ? "#fff" : "#cbd5e1"}
                        />
                      </View>

                      <View style={styles.optionRow}>
                        <View style={styles.optionLeft}>
                          <View>
                            <Text style={styles.optionTitle}>Repetitions</Text>
                            <Text style={styles.optionDescription}>Repeated words/sounds</Text>
                          </View>
                        </View>
                        <Switch
                          value={focusRepetitions}
                          disabled={uiLocked}
                          onValueChange={(val) => {
                            if (uiLocked) return;
                            setFocusRepetitions(val);
                            setSongUploaded(false);
                          }}
                          trackColor={{ false: "#e2e8f0", true: "#6366f1" }}
                          thumbColor={focusRepetitions ? "#fff" : "#cbd5e1"}
                        />
                      </View>
                    </View>

                    <View style={styles.optionRow}>
                      <View style={styles.optionLeft}>
                        <View>
                          <Text style={styles.optionTitle}>Sync to Beat Grid</Text>
                          <Text style={styles.optionDescription}>Snap cuts to nearest beat</Text>
                        </View>
                      </View>
                      <Switch
                        value={syncToGrid}
                        disabled={uiLocked}
                        onValueChange={(val) => {
                          if (uiLocked) return;
                          setSyncToGrid(val);
                          setSongUploaded(false);
                        }}
                        trackColor={{ false: "#e2e8f0", true: "#6366f1" }}
                        thumbColor={syncToGrid ? "#fff" : "#cbd5e1"}
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
            )}
          </View>
        )}

        {/* Duration Section */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionTitleRow}>
              <View style={styles.sectionIconBg}>
                <Ionicons name="time-outline" size={22} color="#6366f1" />
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
                disabled={uiLocked}
                onPress={() => {
                  if (uiLocked) return;
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

          <TouchableOpacity
            style={[styles.songSectionButton, (!song || uiLocked) && styles.buttonDisabled]}
            disabled={!song || uiLocked}
            onPress={() => {
              if (!song || uiLocked) return;
              setShowSongRangeModal(true);
            }}
            activeOpacity={0.75}
          >
            <Ionicons name="musical-notes-outline" size={20} color={song && !uiLocked ? "#4338ca" : "#94a3b8"} />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={styles.songSectionButtonTitle}>Where in the song</Text>
              <Text style={styles.songSectionButtonSub}>
                {song
                  ? `Analyzing from ${Math.floor(songStartSec / 60)}:${Math.floor(songStartSec % 60)
                      .toString()
                      .padStart(2, "0")} · ${duration}s window`
                  : "Pick a song first"}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#94a3b8" />
          </TouchableOpacity>
        </View>

        <SongRangePickerModal
          visible={showSongRangeModal}
          onClose={() => setShowSongRangeModal(false)}
          songUri={song?.uri ?? ""}
          windowDurationSec={duration}
          initialStartSec={songStartSec}
          onConfirm={async (start) => {
            setSongStartSec(start);
            setSongUploaded(false);
            try {
              await fetch(`${SERVER_URL}/api/options`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ song_start_sec: start }),
              });
            } catch {
              // upload will still send song_start_sec
            }
          }}
        />

        

        {/* Generate Button */}
        <View style={styles.section}>
          <TouchableOpacity 
            style={[
              styles.generateButton, 
              !allUploaded && styles.buttonDisabled
            ]}
            onPress={createPreview}
            activeOpacity={0.8}
            disabled={generateLoading || !allUploaded}
          >
            {generateLoading ? (
              <View style={styles.generateButtonLoadingContent}>
                <ActivityIndicator size="small" color="#fff" />
                <Text style={styles.buttonText}>Analyzing...</Text>
              </View>
            ) : (
              <>
                <Text style={styles.buttonText}>
                  {allUploaded ? "Analyze & preview" : "Upload files first"}
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
    backgroundColor: 'rgba(99, 102, 241, 0.16)',
    justifyContent: "center",
    alignItems: "center",
    marginRight: 16,
    shadowColor: "#6366f1",
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
  audioIconContainerSelectedUploaded: {
    backgroundColor: "rgba(99, 102, 241, 0.18)",
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
  musicModalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  musicModalContent: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 24,
    width: "100%",
    maxWidth: 420,
    maxHeight: "85%",
  },
  musicModalTitle: {
    fontSize: 22,
    fontWeight: "800",
    color: "#0f172a",
    marginBottom: 4,
  },
  musicModalSubtitle: {
    fontSize: 14,
    color: "#64748b",
    marginBottom: 18,
  },
  musicModalList: {
    maxHeight: 360,
  },
  musicModalRow: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
  },
  musicModalRowTouch: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 16,
    paddingHorizontal: 4,
  },
  musicModalRowIcon: { fontSize: 28 },
  musicModalRowArt: { width: 56, height: 56, borderRadius: 10, marginRight: 14 },
  musicModalRowArtPlaceholder: {
    width: 56,
    height: 56,
    borderRadius: 10,
    marginRight: 14,
    backgroundColor: "#f1f5f9",
    justifyContent: "center",
    alignItems: "center",
  },
  musicModalRowTextWrap: { flex: 1, minWidth: 0 },
  musicModalRowText: { fontSize: 17, color: "#1e293b", fontWeight: "700" },
  musicModalRowArtist: { fontSize: 14, color: "#64748b", marginTop: 2, fontWeight: "500" },
  musicModalDeleteBtn: { padding: 10 },
  musicModalEmpty: {
    fontSize: 14,
    color: "#94a3b8",
    paddingVertical: 24,
    textAlign: "center",
  },
  musicModalUploadBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    marginTop: 12,
    backgroundColor: "#f1f5f9",
    borderRadius: 12,
  },
  musicModalUploadBtnText: { fontSize: 16, fontWeight: "700", color: "#6366f1" },
  musicModalUploadBtnDisabled: { opacity: 0.6 },
  musicModalCancel: {
    paddingVertical: 12,
    marginTop: 8,
    alignItems: "center",
  },
  musicModalCancelText: { fontSize: 15, fontWeight: "600", color: "#64748b" },
  nameTrackModalBackdrop: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "rgba(0,0,0,0.5)" },
  nameTrackModalContent: { width: Math.min(width * 0.92, 440), backgroundColor: "#fff", borderRadius: 20, padding: 24 },
  nameTrackModalTitle: { fontSize: 22, fontWeight: "800", color: "#0f172a", marginBottom: 4 },
  nameTrackModalHint: { fontSize: 12, color: "#64748b", marginBottom: 16 },
  nameTrackModalBody: { flexDirection: "row", marginBottom: 24, gap: 20 },
  nameTrackArtSquare: { width: ART_SQUARE_SIZE, height: ART_SQUARE_SIZE, borderRadius: 14, overflow: "hidden", backgroundColor: "#f1f5f9" },
  nameTrackArtSquareImage: { width: ART_SQUARE_SIZE, height: ART_SQUARE_SIZE },
  nameTrackArtSquareOverlay: { position: "absolute", bottom: 0, left: 0, right: 0, height: 36, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", alignItems: "center" },
  nameTrackArtSquarePlaceholder: { flex: 1, width: ART_SQUARE_SIZE, height: ART_SQUARE_SIZE, justifyContent: "center", alignItems: "center" },
  nameTrackFields: { flex: 1, minWidth: 0 },
  nameTrackInputWrap: { position: "relative", marginBottom: 12 },
  nameTrackInputTitle: { borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 14, paddingRight: 44, fontSize: 18, fontWeight: "700", color: "#0f172a" },
  nameTrackInput: { borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, paddingRight: 44, fontSize: 16, color: "#334155" },
  nameTrackInputClear: { position: "absolute", right: 12, top: 0, bottom: 0, justifyContent: "center" },
  nameTrackActions: { flexDirection: "row", justifyContent: "flex-end", gap: 12 },
  nameTrackCancelBtn: { paddingVertical: 12, paddingHorizontal: 20 },
  nameTrackCancelBtnText: { fontSize: 15, fontWeight: "600", color: "#64748b" },
  nameTrackSaveBtn: { backgroundColor: "#6366f1", paddingVertical: 12, paddingHorizontal: 24, borderRadius: 12, minWidth: 88, alignItems: "center" },
  nameTrackSaveBtnText: { fontSize: 15, fontWeight: "700", color: "#fff" },
  songSectionButton: {
    marginTop: 14,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#eef2ff",
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: "#c7d2fe",
  },
  songSectionButtonTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#312e81",
  },
  songSectionButtonSub: {
    fontSize: 12,
    color: "#6366f1",
    marginTop: 2,
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
    overflow: "hidden",
  },
  buttonDisabled: {
    backgroundColor: "#cbd5e1",
    borderColor: "#cbd5e1",
    shadowColor: "#000",
    shadowOpacity: 0.1,
  },
  generateButtonLoadingContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    zIndex: 1,
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
  decoyButton: {
    marginTop: 12,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: "#94a3b8",
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  decoyButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#64748b",
  },
  hiddenDemoRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginTop: 12,
  },
  hiddenDemoButton: {
    flex: 1,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(99, 102, 241, 0.35)",
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  hiddenDemoButtonText: {
    fontSize: 13,
    fontWeight: "800",
    color: "#6366f1",
  },
  modeStack: {
    gap: 12,
  },
  inlineAdvancedWrap: {
    marginTop: 12,
  },
  recordTapsButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
    marginBottom: 12,
  },
  recordTapsButtonRecord: {
    backgroundColor: "#6366f1",
  },
  recordTapsButtonRerecord: {
    backgroundColor: "#e2e8f0",
  },
  recordTapsButtonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
  recordTapsButtonTextRerecord: {
    color: "#334155",
  },
  modeCard: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 16,
    borderWidth: 2,
    borderColor: "transparent",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
  },
  modeCardSelected: {
    borderColor: "#6366f1",
    backgroundColor: "#f8f8ff",
  },
  modeCardLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
  },
  modeCardRight: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  modeTextWrap: {
    flex: 1,
  },
  modeTitle: {
    color: "#0f172a",
    fontSize: 16,
    fontWeight: "700",
  },
  modeSubtitle: {
    color: "#64748b",
    fontSize: 13,
    fontWeight: "600",
    marginTop: 2,
  },
  modeCardDisabled: {
    backgroundColor: "#f1f5f9",
    borderColor: "#e2e8f0",
  },
  modeTextDisabled: {
    color: "#94a3b8",
  },
  modeActionBtn: {
    borderWidth: 1,
    borderColor: "#6366f1",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: "#fff",
    minHeight: 34,
    justifyContent: "center",
  },
  modeActionBtnText: {
    color: "#6366f1",
    fontSize: 12,
    fontWeight: "700",
  },
});