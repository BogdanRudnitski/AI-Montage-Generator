import React, { useEffect, useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Alert } from "react-native";
import Slider from "@react-native-community/slider";
import { Video, ResizeMode, AVPlaybackStatus, Audio } from "expo-av";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { SERVER_URL } from "../config";
import { useAnalyze } from "../context/AnalyzeContext";

interface PlayItem {
  uri: string;
  clipStart: number;
  clipEnd: number;
  clipDuration: number;
  segmentDuration: number;
  startTime: number;
  endTime: number;
}

export default function PreviewScreen() {
  const router = useRouter();
  const { analyzeResult, mediaList, songUri } = useAnalyze();
  const videoRefs = [useRef<Video>(null), useRef<Video>(null), useRef<Video>(null)];
  const [currentSegmentIndex, setCurrentSegmentIndex] = useState(0);
  const [playheadTime, setPlayheadTime] = useState(0);
  const visibleSlotIndex = currentSegmentIndex % 3;
  const segmentIndexForSlot = (slot: number) =>
    currentSegmentIndex + (slot - visibleSlotIndex + 3) % 3;
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const segmentStartTimeRef = useRef(0);
  const soundRef = useRef<Audio.Sound | null>(null);
  const hasRedirected = useRef(false);
  const currentIndexRef = useRef(0);
  const totalDuration = analyzeResult?.duration ?? 0;

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // Normalize segment keys (backend sends camelCase; accept snake_case for robustness)
  const normalizeSeg = (seg: Record<string, unknown>) => ({
    startTime: Number(seg.startTime ?? seg.start_time ?? 0),
    endTime: Number(seg.endTime ?? seg.end_time ?? 0),
    clipFilename: String(seg.clipFilename ?? seg.clip_filename ?? ""),
    clipStart: Number(seg.clipStart ?? seg.clip_start ?? 0),
    clipEnd: Number(seg.clipEnd ?? seg.clip_end ?? 0),
  });

  const playList = React.useMemo(() => {
    if (!analyzeResult?.segments?.length || !mediaList.length) return [];
    const segments = analyzeResult.segments as Record<string, unknown>[];
    const mediaFilenames = mediaList.map((m) => m.filename).filter(Boolean);
    const built = segments.map((seg, i) => {
      const s = normalizeSeg(seg);
      const item = mediaList.find(
        (m) =>
          m.filename === s.clipFilename ||
          (m.filename &&
            s.clipFilename &&
            m.filename.replace(/\s/g, "_") === s.clipFilename)
      );
      const uri = item?.uri;
      const clipDuration = s.clipEnd - s.clipStart;
      const segmentDuration = s.endTime - s.startTime;
      if (!uri && i < 3) {
        console.warn(
          `[Preview] Segment ${i + 1} no match: clipFilename="${s.clipFilename}" | media filenames:`,
          mediaFilenames
        );
      }
      return {
        uri,
        clipStart: s.clipStart,
        clipEnd: s.clipEnd,
        clipDuration,
        segmentDuration,
        startTime: s.startTime,
        endTime: s.endTime,
      };
    });
    const filtered = built.filter((p): p is PlayItem => !!p.uri);
    if (filtered.length < segments.length) {
      console.warn(
        `[Preview] Only ${filtered.length}/${segments.length} segments matched media. Check clipFilename vs upload filenames.`
      );
    }
    return filtered;
  }, [analyzeResult, mediaList]);

  // Map global time (0..duration) to segment index and in-clip position
  const getSegmentAtTime = (t: number): { segmentIndex: number; offsetInSegment: number; clipPosition: number } | null => {
    if (!playList.length || t < 0) return null;
    for (let i = 0; i < playList.length; i++) {
      const item = playList[i];
      if (t >= item.startTime && t < item.endTime) {
        const offsetInSegment = t - item.startTime;
        const clipPosition = item.clipStart + offsetInSegment;
        return { segmentIndex: i, offsetInSegment, clipPosition };
      }
    }
    const last = playList[playList.length - 1];
    if (t >= last.endTime)
      return { segmentIndex: playList.length - 1, offsetInSegment: last.segmentDuration, clipPosition: last.clipEnd };
    return null;
  };

  const seekToTime = (time: number, refs: React.RefObject<Video | null>[]) => {
    const info = getSegmentAtTime(time);
    if (!info) return;
    setPlayheadTime(time);
    setCurrentSegmentIndex(info.segmentIndex);
    soundRef.current?.setPositionAsync(time * 1000).catch(() => {});
    const slotIndex = refs.length ? info.segmentIndex % refs.length : 0;
    const ref = refs[slotIndex]?.current;
    if (ref) {
      const item = playList[info.segmentIndex];
      const ms = Math.min(info.clipPosition * 1000, (item?.clipEnd ?? info.clipPosition) * 1000);
      ref.setPositionAsync(ms).catch(() => {});
    }
  };

  useEffect(() => {
    if (!analyzeResult && !hasRedirected.current) {
      hasRedirected.current = true;
      router.replace("/");
      return;
    }
  }, [analyzeResult, router]);

  // Play song in background (preview = music + muted clips)
  useEffect(() => {
    if (!songUri) return;
    let mounted = true;
    (async () => {
      try {
        await Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          shouldDuckAndroid: true,
          playThroughEarpieceAndroid: false,
        });
        const { sound } = await Audio.Sound.createAsync(
          { uri: songUri },
          { shouldPlay: true, isLooping: false }
        );
        if (mounted) soundRef.current = sound;
      } catch (e) {
        console.warn("Preview: could not play song", e);
      }
    })();
    return () => {
      mounted = false;
      soundRef.current?.unloadAsync().catch(() => {});
      soundRef.current = null;
    };
  }, [songUri]);

  currentIndexRef.current = currentSegmentIndex;

  const advanceTo = (nextIndex: number) => {
    if (nextIndex >= playList.length) {
      setCurrentSegmentIndex(0);
      return;
    }
    setCurrentSegmentIndex(nextIndex);
  };

  const onPlaybackStatusUpdate =
    (slot: number) => (status: AVPlaybackStatus) => {
      if (!status.isLoaded || playList.length === 0 || isScrubbing) return;
      if (slot !== currentIndexRef.current % 3) return;

      const idx = currentIndexRef.current;
      const seg = playList[idx];
      if (!seg) return;
      const position = status.positionMillis / 1000;
      const totalElapsed = Date.now() / 1000 - segmentStartTimeRef.current;
      setPlayheadTime(seg.startTime + Math.min(totalElapsed, seg.segmentDuration));

      const atClipEnd = position >= seg.clipEnd - 0.06;
      const segmentDone =
        totalElapsed >= seg.segmentDuration - 0.08 || atClipEnd;

      if (seg.segmentDuration <= seg.clipDuration) {
        if (atClipEnd) advanceTo(idx + 1);
      } else {
        if (segmentDone) advanceTo(idx + 1);
        else if (atClipEnd)
          videoRefs[slot].current?.setPositionAsync(seg.clipStart * 1000).catch(() => {});
      }
    };

  const seg = playList[currentSegmentIndex];

  useEffect(() => {
    if (!seg || isScrubbing) return;
    const info = getSegmentAtTime(playheadTime);
    const inSegment = info && info.segmentIndex === currentSegmentIndex;
    const startSec = inSegment ? info!.clipPosition : seg.clipStart;
    segmentStartTimeRef.current = Date.now() / 1000 - (inSegment ? playheadTime - seg.startTime : 0);
    const activeRef = videoRefs[visibleSlotIndex].current;
    const startMs = startSec * 1000;
    if (activeRef?.playFromPositionAsync) {
      activeRef.playFromPositionAsync(startMs).catch(() => {});
    } else {
      activeRef?.setPositionAsync(startMs).catch(() => {});
      activeRef?.playAsync().catch(() => {});
    }
    [1, 2].forEach((delta) => {
      const slot = (visibleSlotIndex + delta) % 3;
      const segIdx = currentSegmentIndex + delta;
      const nextItem = playList[segIdx];
      if (nextItem)
        videoRefs[slot].current?.setPositionAsync(nextItem.clipStart * 1000).catch(() => {});
    });
  }, [currentSegmentIndex, playList, visibleSlotIndex, isScrubbing]);

  if (!analyzeResult) return null;
  const totalSegments = playList.length;

  async function handleExport() {
    try {
      setIsExporting(true);
      const res = await fetch(`${SERVER_URL}/export`, { method: "POST" });
      const data = await res.json();
      if (!data.success) {
        Alert.alert("Export Failed", data.error || "Unknown error");
        setIsExporting(false);
        return;
      }
      const video = data.final_video;
      if (video?.url != null && video?.name != null) {
        router.replace({
          pathname: "/result",
          params: { videoUrl: video.url, videoName: video.name },
        });
      } else {
        router.replace("/loading");
      }
    } catch (err) {
      console.error(err);
      Alert.alert("Export Failed", "Check your network connection.");
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.replace("/")}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <View>
          <Text style={styles.headerTitle}>Preview</Text>
          <Text style={styles.headerSubtitle}>Music + clips · Tap Export to render</Text>
        </View>
      </View>
      <View style={styles.videoContainer}>
        {seg?.uri ? (
          <>
            {[0, 1, 2].map((slot) => {
              const segIdx = Math.min(segmentIndexForSlot(slot), playList.length - 1);
              const item = playList[segIdx];
              const isVisible = slot === visibleSlotIndex;
              if (!item?.uri) return null;
              return (
                <Video
                  key={slot}
                  ref={videoRefs[slot]}
                  source={{ uri: item.uri }}
                  style={[styles.video, isVisible ? styles.videoVisible : styles.videoHidden]}
                  resizeMode={ResizeMode.COVER}
                  shouldPlay={isVisible && !isScrubbing}
                  isLooping={false}
                  volume={0}
                  muted
                  onPlaybackStatusUpdate={onPlaybackStatusUpdate(slot)}
                />
              );
            })}
          </>
        ) : (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderText}>No clip for segment {currentSegmentIndex + 1}</Text>
            <Text style={styles.placeholderHint}>Filename may not match. Check upload names.</Text>
          </View>
        )}
      </View>
      {totalDuration > 0 && (
        <View style={styles.sliderRow}>
          <Text style={styles.sliderTime}>{formatTime(playheadTime)}</Text>
          <Slider
            style={styles.slider}
            value={playheadTime}
            minimumValue={0}
            maximumValue={totalDuration}
            minimumTrackTintColor="#6366f1"
            maximumTrackTintColor="#e2e8f0"
            thumbTintColor="#6366f1"
            onSlidingStart={() => {
              setIsScrubbing(true);
              videoRefs[visibleSlotIndex].current?.pauseAsync().catch(() => {});
              soundRef.current?.pauseAsync().catch(() => {});
            }}
            onValueChange={(v) => setPlayheadTime(v)}
            onSlidingComplete={(v) => {
              setPlayheadTime(v);
              const info = getSegmentAtTime(v);
              if (info !== null) {
                setCurrentSegmentIndex(info.segmentIndex);
                soundRef.current?.setPositionAsync(v * 1000).catch(() => {});
              }
              setIsScrubbing(false);
              soundRef.current?.playAsync().catch(() => {});
            }}
          />
          <Text style={styles.sliderTime}>{formatTime(totalDuration)}</Text>
        </View>
      )}
      <View style={styles.footer}>
        <Text style={styles.segmentInfo}>
          Segment {currentSegmentIndex + 1} / {totalSegments} · {analyzeResult.duration.toFixed(1)}s
        </Text>
        <TouchableOpacity
          style={[styles.exportButton, isExporting && styles.exportButtonDisabled]}
          onPress={handleExport}
          disabled={isExporting}
        >
          <Ionicons name="download-outline" size={24} color="#fff" />
          <Text style={styles.exportButtonText}>{isExporting ? "Exporting…" : "Export video"}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f5f7fb" },
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
  headerTitle: { fontSize: 28, fontWeight: "900", color: "#fff", marginBottom: 4 },
  headerSubtitle: { fontSize: 15, color: "rgba(255,255,255,0.95)", fontWeight: "600" },
  videoContainer: { flex: 1, backgroundColor: "#000", position: "relative" },
  video: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, width: "100%", height: "100%" },
  videoVisible: { zIndex: 1 },
  videoHidden: { zIndex: 0 },
  sliderRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: "#fff",
    gap: 12,
  },
  slider: { flex: 1, height: 40 },
  sliderTime: { fontSize: 12, color: "#64748b", minWidth: 36, textAlign: "center" },
  placeholder: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#1e293b",
  },
  placeholderText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  placeholderHint: { color: "#94a3b8", fontSize: 12, marginTop: 8 },
  footer: { padding: 24, backgroundColor: "#fff" },
  segmentInfo: { fontSize: 14, color: "#64748b", marginBottom: 16, textAlign: "center" },
  exportButton: {
    backgroundColor: "#6366f1",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 18,
    borderRadius: 16,
  },
  exportButtonDisabled: { opacity: 0.7 },
  exportButtonText: { color: "#fff", fontSize: 18, fontWeight: "800" },
});
