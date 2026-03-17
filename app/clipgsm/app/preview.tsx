import React, { useEffect, useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Alert, Image, Dimensions, ScrollView } from "react-native";
import { Video, ResizeMode, AVPlaybackStatus, Audio } from "expo-av";
let VideoThumbnails: typeof import("expo-video-thumbnails") | null = null;
try {
  VideoThumbnails = require("expo-video-thumbnails");
} catch {
  // Optional: run npx expo install expo-video-thumbnails
}
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { SERVER_URL } from "../config";
import { useAnalyze } from "../context/AnalyzeContext";
import TimelineStrip from "../components/TimelineStrip";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const STRIP_HEIGHT = 48;
const BLOCK_GAP = 4;
const BLOCK_BORDER_RADIUS = 6;
const SECONDS_PER_VIEWPORT = 10;
const RESIZE_EDGE_WIDTH = 28;
const SCRUB_HIT_SLOP = 24; // only move playhead when touch is within this many px of the line

function debugLog(tag: string, data?: object) {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.log("[Preview]", tag, data ?? "");
  }
}

interface SegmentRecord {
  startTime: number;
  endTime: number;
  clipFilename: string;
  clipStart: number;
  clipEnd: number;
}

interface PlayItem {
  uri?: string;
  clipStart: number;
  clipEnd: number;
  clipDuration: number;
  segmentDuration: number;
  startTime: number;
  endTime: number;
  clipFilename?: string;
}

// Preview uses only local data: clip URIs from ImagePicker (mediaList), segment data from in-memory analyzeResult. No video fetch from backend.
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
  const [isPlaying, setIsPlaying] = useState(true);
  const [selectedSegmentIndex, setSelectedSegmentIndex] = useState<number | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [thumbnailUris, setThumbnailUris] = useState<(string | null)[]>([]);
  const [timelineScrollX, setTimelineScrollX] = useState(0);
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(0);
  const [resizeMode, setResizeMode] = useState<"moveCut" | "trim">("moveCut");
  const timelineScrollRef = useRef<ScrollView>(null);
  const segmentStartTimeRef = useRef(0);
  const soundRef = useRef<Audio.Sound | null>(null);
  const hasRedirected = useRef(false);
  const currentIndexRef = useRef(0);
  const playheadTimeRef = useRef(0);
  playheadTimeRef.current = playheadTime;
  const segmentsRef = useRef<SegmentRecord[]>([]);
  // Editable segments: source of truth for timeline; initialized from analyze result, updated on resize
  const [segments, setSegments] = useState<SegmentRecord[]>([]);
  segmentsRef.current = segments;
  const segmentsInitialized = useRef(false);
  useEffect(() => {
    const raw = analyzeResult?.segments as Record<string, unknown>[] | undefined;
    if (raw?.length && !segmentsInitialized.current) {
      setSegments(
        raw.map((s) => ({
          startTime: Number(s.startTime ?? s.start_time ?? 0),
          endTime: Number(s.endTime ?? s.end_time ?? 0),
          clipFilename: String(s.clipFilename ?? s.clip_filename ?? ""),
          clipStart: Number(s.clipStart ?? s.clip_start ?? 0),
          clipEnd: Number(s.clipEnd ?? s.clip_end ?? 0),
        }))
      );
      segmentsInitialized.current = true;
    }
  }, [analyzeResult?.segments]);
  const totalDuration =
    segments.length > 0 ? segments[segments.length - 1].endTime : (analyzeResult?.duration ?? 0);

  const stripWidth =
    totalDuration > 0 ? (totalDuration / SECONDS_PER_VIEWPORT) * SCREEN_WIDTH : SCREEN_WIDTH;

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // Full segment list (no dropping) so preview matches export 1:1; built from editable segments
  const playList = React.useMemo(() => {
    if (!segments.length) return [];
    const mediaFilenames = mediaList?.map((m) => m.filename).filter(Boolean) ?? [];
    const built: PlayItem[] = segments.map((s, i) => {
      const item = mediaList?.find(
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
        clipFilename: s.clipFilename,
        clipStart: s.clipStart,
        clipEnd: s.clipEnd,
        clipDuration,
        segmentDuration,
        startTime: s.startTime,
        endTime: s.endTime,
      };
    });
    return built;
  }, [segments, mediaList]);

  useEffect(() => {
    if (!playList.length || !VideoThumbnails) return;
    let cancelled = false;
    (async () => {
      const results = await Promise.all(
        playList.map(async (item) => {
          if (!item.uri) return null;
          try {
            const { uri } = await VideoThumbnails!.getThumbnailAsync(item.uri, {
              time: item.clipStart * 1000,
            });
            return uri;
          } catch {
            return null;
          }
        })
      );
      if (!cancelled) setThumbnailUris(results);
    })();
    return () => { cancelled = true; };
  }, [playList]);

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
    const item = playList[info.segmentIndex];
    if (item?.uri) {
      const slotIndex = refs.length ? info.segmentIndex % refs.length : 0;
      const ref = refs[slotIndex]?.current;
      if (ref) {
        const ms = Math.min(info.clipPosition * 1000, (item.clipEnd ?? info.clipPosition) * 1000);
        ref.setPositionAsync(ms).catch(() => {});
      }
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
    const fromIndex = currentIndexRef.current;
    if (nextIndex >= playList.length) {
      debugLog("advanceTo", { fromIndex, toIndex: 0, loop: true });
      setCurrentSegmentIndex(0);
      setPlayheadTime(0);
      segmentStartTimeRef.current = Date.now() / 1000;
      soundRef.current?.setPositionAsync(0).catch(() => {});
      return;
    }
    debugLog("advanceTo", { fromIndex, toIndex: nextIndex });
    segmentStartTimeRef.current = Date.now() / 1000;
    setCurrentSegmentIndex(nextIndex);
  };

  const onPlaybackStatusUpdate =
    (slot: number) => (status: AVPlaybackStatus) => {
      if (!status.isLoaded || playList.length === 0 || isScrubbing) return;
      if (slot !== currentIndexRef.current % 3) return;

      const idx = currentIndexRef.current;
      const seg = playList[idx];
      if (!seg || !seg.uri) return;
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

  const segmentBoundsRef = useRef({ startTime: 0, endTime: 0 });
  if (seg) {
    segmentBoundsRef.current = { startTime: seg.startTime, endTime: seg.endTime };
  }

  const playheadLogThrottleRef = useRef(0);
  // Smooth playhead: single source of truth; when playhead crosses segment boundary, advance so clip stays in sync
  useEffect(() => {
    if (isScrubbing || !playList.length || !isPlaying) return;
    const intervalId = setInterval(() => {
      const elapsed = Date.now() / 1000 - segmentStartTimeRef.current;
      const { startTime, endTime } = segmentBoundsRef.current;
      const duration = endTime - startTime;
      const t = startTime + Math.min(elapsed, duration);
      setPlayheadTime(t);
      const info = getSegmentAtTime(t);
      if (info && info.segmentIndex !== currentIndexRef.current) {
        advanceTo(info.segmentIndex);
      }
      if (__DEV__ && Date.now() - playheadLogThrottleRef.current > 1000) {
        playheadLogThrottleRef.current = Date.now();
        debugLog("playhead", { playheadTime: t, segmentIndex: currentIndexRef.current });
      }
    }, 50);
    return () => clearInterval(intervalId);
  }, [isScrubbing, playList.length, isPlaying]);

  // When current segment has no clip, advance after segment duration; do not set playheadTime here (50ms interval is single source)
  useEffect(() => {
    if (!seg || seg.uri || isScrubbing || playList.length === 0 || !isPlaying) return;
    segmentStartTimeRef.current = Date.now() / 1000 - (playheadTime - seg.startTime);
    const duration = seg.segmentDuration;
    const timeoutId = setTimeout(() => {
      advanceTo(currentSegmentIndex + 1);
    }, duration * 1000);
    return () => clearTimeout(timeoutId);
  }, [currentSegmentIndex, playList.length, seg?.startTime, seg?.endTime, seg?.segmentDuration, seg?.uri, isScrubbing, isPlaying]);

  useEffect(() => {
    if (!seg || isScrubbing || !isPlaying) return;
    const info = getSegmentAtTime(playheadTime);
    const inSegment = info && info.segmentIndex === currentSegmentIndex;
    const startSec = inSegment ? info!.clipPosition : seg.clipStart;
    segmentStartTimeRef.current = Date.now() / 1000 - (inSegment ? playheadTime - seg.startTime : 0);
    if (seg.uri) {
      const activeRef = videoRefs[visibleSlotIndex].current;
      const startMs = startSec * 1000;
      if (activeRef?.playFromPositionAsync) {
        activeRef.playFromPositionAsync(startMs).catch(() => {});
      } else {
        activeRef?.setPositionAsync(startMs).catch(() => {});
        activeRef?.playAsync().catch(() => {});
      }
    }
    const nextSlot = (visibleSlotIndex + 1) % 3;
    const nextNextSlot = (visibleSlotIndex + 2) % 3;
    const nextItem = playList[currentSegmentIndex + 1];
    const nextNextItem = playList[currentSegmentIndex + 2];
    let warmId: ReturnType<typeof setTimeout> | null = null;
    if (nextItem?.uri) {
      videoRefs[nextSlot].current?.setPositionAsync(nextItem.clipStart * 1000).catch(() => {});
      const nextRef = videoRefs[nextSlot].current;
      if (nextRef) {
        nextRef.playAsync().catch(() => {});
        warmId = setTimeout(() => nextRef.pauseAsync().catch(() => {}), 120);
      }
    }
    if (nextNextItem?.uri)
      videoRefs[nextNextSlot].current?.setPositionAsync(nextNextItem.clipStart * 1000).catch(() => {});
    return () => { if (warmId) clearTimeout(warmId); };
  }, [currentSegmentIndex, playList, visibleSlotIndex, isScrubbing, isPlaying]);

  useEffect(() => {
    const max = Math.max(0, stripWidth - timelineViewportWidth);
    if (timelineScrollX > max) {
      setTimelineScrollX(max);
      timelineScrollRef.current?.scrollTo({ x: max, animated: false });
    }
  }, [stripWidth, timelineViewportWidth, timelineScrollX]);

  if (!analyzeResult) return null;
  const totalSegments = playList.length;

  async function handleExport() {
    try {
      setIsExporting(true);
      const body = segments.length > 0 ? { segments } : undefined;
      const res = await fetch(`${SERVER_URL}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
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
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Preview</Text>
          <Text style={styles.headerSubtitle}>Music + clips · Tap Export to render</Text>
        </View>
        <TouchableOpacity
          style={styles.pauseButton}
          onPress={() => {
            const next = !isPlaying;
            setIsPlaying(next);
            if (!next) {
              videoRefs[visibleSlotIndex].current?.pauseAsync().catch(() => {});
              soundRef.current?.pauseAsync().catch(() => {});
            } else {
              soundRef.current?.playAsync().catch(() => {});
            }
          }}
        >
          <Ionicons name={isPlaying ? "pause" : "play"} size={24} color="#fff" />
        </TouchableOpacity>
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
                  shouldPlay={isPlaying && isVisible && !isScrubbing}
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
      {totalDuration > 0 && playList.length > 0 && (
        <TimelineStrip
          segments={segments}
          totalDuration={totalDuration}
          playheadTime={playheadTime}
          onPlayheadChange={(t) => {
            playheadTimeRef.current = t;
            setPlayheadTime(t);
            const info = getSegmentAtTime(t);
            if (info !== null) {
              setCurrentSegmentIndex(info.segmentIndex);
              const item = playList[info.segmentIndex];
              if (item?.uri) {
                const slot = info.segmentIndex % 3;
                const ms = Math.min(info.clipPosition * 1000, (item.clipEnd ?? info.clipPosition) * 1000);
                videoRefs[slot].current?.setPositionAsync(ms).catch(() => {});
              }
              soundRef.current?.setPositionAsync(t * 1000).catch(() => {});
            }
          }}
          onSegmentsChange={(next) => setSegments((_prev) => next)}
          selectedSegmentIndex={selectedSegmentIndex}
          onSelectSegment={(i) => {
            setSelectedSegmentIndex(i);
            const t = playheadTimeRef.current;
            const info = getSegmentAtTime(t);
            if (info !== null) {
              setCurrentSegmentIndex(info.segmentIndex);
              const item = playList[info.segmentIndex];
              if (item?.uri) {
                const slot = info.segmentIndex % 3;
                const ms = Math.min(info.clipPosition * 1000, (item.clipEnd ?? info.clipPosition) * 1000);
                videoRefs[slot].current?.setPositionAsync(ms).catch(() => {});
              }
              soundRef.current?.setPositionAsync(t * 1000).catch(() => {});
            }
          }}
          thumbnailUris={thumbnailUris}
          onScrubbingChange={(scrubbing) => {
            setIsScrubbing(scrubbing);
            if (scrubbing) {
              videoRefs[visibleSlotIndex].current?.pauseAsync().catch(() => {});
              soundRef.current?.pauseAsync().catch(() => {});
            } else if (isPlaying) {
              soundRef.current?.playAsync().catch(() => {});
            }
          }}
          timelineScrollX={timelineScrollX}
          onTimelineScrollChange={setTimelineScrollX}
          timelineViewportWidth={timelineViewportWidth}
          onTimelineViewportLayout={setTimelineViewportWidth}
          timelineScrollRef={timelineScrollRef}
          resizeMode={resizeMode}
        />
      )}
      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.resizeModeButton, resizeMode === "trim" && styles.resizeModeButtonActive]}
          onPress={() => setResizeMode((m) => (m === "moveCut" ? "trim" : "moveCut"))}
        >
          <Text style={[styles.resizeModeButtonText, resizeMode === "trim" && styles.resizeModeButtonTextActive]}>
            {resizeMode === "moveCut" ? "Move cut" : "Trim"}
          </Text>
        </TouchableOpacity>
        <Text style={styles.segmentInfo}>
          Segment {currentSegmentIndex + 1} / {totalSegments} · {(totalDuration || (analyzeResult?.duration ?? 0)).toFixed(1)}s
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
  headerCenter: { flex: 1 },
  pauseButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    justifyContent: "center",
    alignItems: "center",
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
  stripContainer: {
    backgroundColor: "#fff",
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  stripTimeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    marginBottom: 6,
  },
  sliderTime: { fontSize: 12, color: "#64748b", minWidth: 36, textAlign: "center" },
  timelineScrollView: {
    marginBottom: 4,
  },
  timelineScrollViewInner: {
    height: STRIP_HEIGHT + 4,
  },
  scrollTrack: {
    height: 28,
    marginTop: 4,
    paddingHorizontal: 8,
    justifyContent: "center",
    backgroundColor: "rgba(100, 116, 139, 0.15)",
    borderRadius: 14,
  },
  scrollTrackThumb: {
    position: "absolute",
    height: 20,
    top: 4,
    borderRadius: 10,
    backgroundColor: "#6366f1",
  },
  timelineScrollContent: {
    flexGrow: 0,
  },
  frameStripWrap: {
    height: STRIP_HEIGHT,
    position: "relative",
    overflow: "hidden",
  },
  frameStripRow: {
    flexDirection: "row",
    alignItems: "stretch",
    height: STRIP_HEIGHT,
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
  },
  thumbFrame: {
    overflow: "hidden",
    backgroundColor: "#1e293b",
    minWidth: 4,
  },
  thumbFrameSelected: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderLeftWidth: RESIZE_EDGE_WIDTH,
    borderRightWidth: RESIZE_EDGE_WIDTH,
    borderColor: "#6366f1",
  },
  selectedBlockWrapper: {
    position: "relative",
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderLeftWidth: RESIZE_EDGE_WIDTH,
    borderRightWidth: RESIZE_EDGE_WIDTH,
    borderColor: "#6366f1",
  },
  resizeEdge: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: RESIZE_EDGE_WIDTH,
    zIndex: 10,
  },
  resizeEdgeRight: {
    left: undefined,
    right: 0,
  },
  thumbImage: {
    width: "100%",
    height: "100%",
  },
  thumbPlaceholder: {
    flex: 1,
    backgroundColor: "#334155",
    minHeight: STRIP_HEIGHT,
  },
  stripPlayhead: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 4,
    backgroundColor: "#6366f1",
    borderRadius: 2,
    zIndex: 1,
  },
  resizeHandle: {
    position: "absolute",
    top: 0,
    bottom: 0,
    zIndex: 2,
    backgroundColor: "#6366f1",
  },
  placeholder: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#1e293b",
  },
  placeholderText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  placeholderHint: { color: "#94a3b8", fontSize: 12, marginTop: 8 },
  footer: { padding: 24, backgroundColor: "#fff", flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 },
  resizeModeButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: "rgba(99, 102, 241, 0.2)",
    borderRadius: 8,
  },
  resizeModeButtonActive: { backgroundColor: "#6366f1" },
  resizeModeButtonText: { color: "#6366f1", fontSize: 13, fontWeight: "600" },
  resizeModeButtonTextActive: { color: "#fff" },
  segmentInfo: { fontSize: 14, color: "#64748b", marginBottom: 16, textAlign: "center", flex: 1 },
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
