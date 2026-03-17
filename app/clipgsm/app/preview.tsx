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
const RESIZE_EDGE_WIDTH = 28;
const SCRUB_HIT_SLOP = 24; // only move playhead when touch is within this many px of the line

// Time-based thumbnail density: one frame every THUMBNAIL_INTERVAL_SEC, clamped by MAX_THUMBNAILS_PER_CLIP.
// MIN_CLIP_DURATION is also used when clamping very short clips during resize logic.
const THUMBNAIL_INTERVAL_SEC = 0.5;
const MAX_THUMBNAILS_PER_CLIP = 20;
const MIN_CLIP_DURATION = 0.1;

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
  const NUM_VIDEO_SLOTS = 3;
  const videoRefs = [useRef<Video>(null), useRef<Video>(null), useRef<Video>(null)];
  const fileDurationByUriRef = useRef<Record<string, number>>({});
  const visiblePlaybackSlotRef = useRef(0);
  const [visiblePlaybackSlot, setVisiblePlaybackSlot] = useState(0);
  const currentVisibleSlotRef = useRef(0);
  const [currentSegmentIndex, setCurrentSegmentIndex] = useState(0);
  const [playheadTime, setPlayheadTime] = useState(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [isPlaying, setIsPlaying] = useState(true);
  const [selectedSegmentIndex, setSelectedSegmentIndex] = useState<number | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [thumbnailUris, setThumbnailUris] = useState<(string | null)[]>([]);
  const [thumbnailFrameUris, setThumbnailFrameUris] = useState<(string | null)[][]>([]);
  const [timelineScrollX, setTimelineScrollX] = useState(0);
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(0);
  const [secondsPerViewport, setSecondsPerViewport] = useState(10);
  const [resizeMode, setResizeMode] = useState<"moveCut" | "trim">("moveCut");
  const timelineScrollRef = useRef<ScrollView>(null);
  const segmentStartTimeRef = useRef(0);
  const soundRef = useRef<Audio.Sound | null>(null);
  const hasRedirected = useRef(false);
  const currentIndexRef = useRef(0);
  const lastAdvanceAtRef = useRef(0);
  const ADVANCE_DEBOUNCE_MS = 450;
  const playheadTimeRef = useRef(0);
  playheadTimeRef.current = playheadTime;
  const pendingScrubTimeRef = useRef<number | null>(null);
  const pendingSeekRef = useRef<{ segmentIndex: number; clipPosition: number } | null>(null);
  const scrubRafRef = useRef<number | null>(null);
  const isScrubbingRef = useRef(false);
  const isResizingRef = useRef(false);
  const lastImmediateScrubSeekAtRef = useRef(0);
  const prevSlotUrisRef = useRef<string[]>([]);
  const loopSeekInFlightRef = useRef<Record<number, boolean>>({});
  const lastLoopSeekAtRef = useRef<Record<number, number>>({});
  // Cache per video URI and timestamp (sec). Extending a clip reuses cached timestamps and only generates new ones.
  const thumbnailCacheRef = useRef<Record<string, Record<string, string>>>({});
  const segmentsRef = useRef<SegmentRecord[]>([]);
  // Editable segments: source of truth for timeline; initialized from analyze result, updated on resize
  const [segments, setSegments] = useState<SegmentRecord[]>([]);
  segmentsRef.current = segments;
  const segmentsInitialized = useRef(false);
  useEffect(() => {
    const raw = analyzeResult?.segments as Record<string, unknown>[] | undefined;
    if (raw?.length && !segmentsInitialized.current) {
      setSegments(
        raw.map((s) => {
          const startTime = Number(s.startTime ?? s.start_time ?? 0);
          const endTime = Number(s.endTime ?? s.end_time ?? 0);
          const clipStart = Number(s.clipStart ?? s.clip_start ?? 0);
          let clipEnd = Number(s.clipEnd ?? s.clip_end ?? 0);
          if (clipEnd <= clipStart && endTime > startTime) {
            clipEnd = clipStart + (endTime - startTime);
          }
          return {
            startTime,
            endTime,
            clipFilename: String(s.clipFilename ?? s.clip_filename ?? ""),
            clipStart,
            clipEnd,
          };
        })
      );
      segmentsInitialized.current = true;
    }
  }, [analyzeResult?.segments]);
  const totalDuration =
    segments.length > 0 ? segments[segments.length - 1].endTime : (analyzeResult?.duration ?? 0);

  const stripWidth =
    totalDuration > 0 ? (totalDuration / secondsPerViewport) * SCREEN_WIDTH : SCREEN_WIDTH;

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

  const getPlaybackSlotForRelativeOffset = (offset: number, base: number) => (base + offset) % 3;
  const visibleSlotIndex = visiblePlaybackSlot;
  currentVisibleSlotRef.current = visibleSlotIndex;

  const getSegmentIndexForPlaybackSlot = (slot: number) =>
    currentSegmentIndex + ((slot - visiblePlaybackSlot + NUM_VIDEO_SLOTS) % NUM_VIDEO_SLOTS);

  const THUMBNAIL_REQUEST_DELAY_MS = 120;

  // Time-based thumbnails cached per video URI and timestamp. Extending a clip keeps existing thumbnails and only generates new timestamps.
  useEffect(() => {
    if (!playList.length || !VideoThumbnails) return;
    if (isResizingRef.current) {
      debugLog("thumbnails:skip-resizing");
      return;
    }

    if (__DEV__) {
      debugLog("thumbnails:start", {
        playListLength: playList.length,
        intervalSec: THUMBNAIL_INTERVAL_SEC,
        maxPerClip: MAX_THUMBNAILS_PER_CLIP,
      });
    }

    let cancelled = false;
    const listLength = playList.length;

    (async () => {
      for (let segmentIndex = 0; segmentIndex < listLength; segmentIndex++) {
        if (cancelled) break;
        const seg = playList[segmentIndex];
        if (!seg?.uri) {
          setThumbnailFrameUris((prev) => {
            const updated = prev.length >= listLength ? [...prev.slice(0, listLength)] : [...prev, ...Array.from({ length: listLength - prev.length }, () => [])];
            updated[segmentIndex] = [];
            return updated;
          });
          setThumbnailUris((prev) => {
            const updated = prev.length >= listLength ? [...prev.slice(0, listLength)] : [...prev, ...Array(listLength - prev.length).fill(null)];
            updated[segmentIndex] = null;
            return updated;
          });
          continue;
        }

        const clipDuration = Math.max(MIN_CLIP_DURATION, seg.clipEnd - seg.clipStart);
        const frameCount = Math.min(
          Math.max(1, Math.ceil(clipDuration / THUMBNAIL_INTERVAL_SEC)),
          MAX_THUMBNAILS_PER_CLIP
        );

        if (!thumbnailCacheRef.current[seg.uri]) {
          thumbnailCacheRef.current[seg.uri] = {};
        }
        const uriCache = thumbnailCacheRef.current[seg.uri];
        const frames: (string | null)[] = [];
        let needGenerate = false;

        for (let i = 0; i < frameCount; i++) {
          const rawTime = seg.clipStart + i * THUMBNAIL_INTERVAL_SEC;
          const timeSec = Math.min(rawTime, seg.clipEnd);
          const timeKey = String(Math.round(timeSec * 1000) / 1000);
          const cached = uriCache[timeKey];
          if (cached) {
            frames.push(cached);
          } else {
            frames.push(null);
            needGenerate = true;
          }
        }

        if (!needGenerate) {
          if (__DEV__) {
            debugLog("thumbnail:cache-hit", { uri: seg.uri, clipStart: seg.clipStart, clipEnd: seg.clipEnd, frameCount });
          }
          setThumbnailFrameUris((prev) => {
            const updated = prev.length >= listLength ? [...prev.slice(0, listLength)] : [...prev, ...Array.from({ length: listLength - prev.length }, () => [])];
            updated[segmentIndex] = frames;
            return updated;
          });
          setThumbnailUris((prev) => {
            const updated = prev.length >= listLength ? [...prev.slice(0, listLength)] : [...prev, ...Array(listLength - prev.length).fill(null)];
            updated[segmentIndex] = frames[0] ?? null;
            return updated;
          });
          continue;
        }

        if (__DEV__) {
          debugLog("thumbnail:generate", { uri: seg.uri, clipStart: seg.clipStart, clipEnd: seg.clipEnd, frameCount });
        }

        for (let i = 0; i < frameCount; i++) {
          if (cancelled) break;
          const rawTime = seg.clipStart + i * THUMBNAIL_INTERVAL_SEC;
          const timeSec = Math.min(rawTime, seg.clipEnd);
          const timeKey = String(Math.round(timeSec * 1000) / 1000);
          if (uriCache[timeKey]) {
            frames[i] = uriCache[timeKey];
            continue;
          }
          try {
            const { uri } = await VideoThumbnails!.getThumbnailAsync(seg.uri!, {
              time: Math.round(timeSec * 1000),
            });
            if (cancelled) break;
            if (uri) {
              uriCache[timeKey] = uri;
              frames[i] = uri;
            }
          } catch {
            // leave frames[i] as null
          }
          if (cancelled) break;
          if (THUMBNAIL_REQUEST_DELAY_MS > 0) {
            await new Promise((r) => setTimeout(r, THUMBNAIL_REQUEST_DELAY_MS));
          }
        }

        if (cancelled) break;

        setThumbnailFrameUris((prev) => {
          const updated = prev.length >= listLength ? [...prev.slice(0, listLength)] : [...prev, ...Array.from({ length: listLength - prev.length }, () => [])];
          updated[segmentIndex] = frames;
          return updated;
        });
        setThumbnailUris((prev) => {
          const updated = prev.length >= listLength ? [...prev.slice(0, listLength)] : [...prev, ...Array(listLength - prev.length).fill(null)];
          updated[segmentIndex] = frames[0] ?? null;
          return updated;
        });
      }

      if (cancelled && __DEV__) debugLog("thumbnails:cancelled");
      if (!cancelled && __DEV__) debugLog("thumbnails:done", { clips: listLength });
    })();

    return () => {
      cancelled = true;
    };
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

  const clampToFileDuration = (uri: string | undefined, sec: number) => {
    if (!uri) return sec;
    const fileDur = fileDurationByUriRef.current[uri];
    if (fileDur == null || fileDur <= 0) return sec;
    return Math.min(sec, fileDur - 0.05);
  };

  /** For scrubbing: use segment clip range so expanded region shows new frames; only clamp if we'd seek past known file end. */
  const seekSecForScrub = (item: PlayItem, clipPosition: number): number => {
    const sec = Math.min(clipPosition, item.clipEnd ?? clipPosition);
    const fileDur = item.uri ? fileDurationByUriRef.current[item.uri] : undefined;
    if (fileDur != null && fileDur > 0 && sec > fileDur - 0.05) return fileDur - 0.05;
    return sec;
  };

  const seekToTime = (time: number, refs: React.RefObject<Video | null>[]) => {
    const info = getSegmentAtTime(time);
    if (!info) return;
    setPlayheadTime(time);
    setCurrentSegmentIndex(info.segmentIndex);
    soundRef.current?.setPositionAsync(time * 1000).catch(() => {});
    const item = playList[info.segmentIndex];
    if (item?.uri) {
      const slotIndex = currentVisibleSlotRef.current;
      const ref = refs[slotIndex]?.current;
      if (ref) {
        const sec = seekSecForScrub(item, info.clipPosition);
        ref.setPositionAsync(sec * 1000).catch(() => {});
      }
    }
  };

  const applyScrubFrame = () => {
    scrubRafRef.current = null;
    const t = pendingScrubTimeRef.current;
    if (t === null) return;
    playheadTimeRef.current = t;
    setPlayheadTime(t);
    const info = getSegmentAtTime(t);
    if (info !== null) {
      const targetIndex = info.segmentIndex;
      const currentIndex = currentIndexRef.current;
      const item = playList[targetIndex];

      // Always keep audio in sync with the playhead
      soundRef.current?.setPositionAsync(t * 1000).catch(() => {});

      if (item?.uri && targetIndex === currentIndex) {
        // SAME SEGMENT: seek the currently visible player immediately (throttled) for smooth scrubbing
        const now = Date.now();
        if (now - lastImmediateScrubSeekAtRef.current >= 16) {
          lastImmediateScrubSeekAtRef.current = now;
          const sec = seekSecForScrub(item, info.clipPosition);
          const slot = currentVisibleSlotRef.current;
          if (__DEV__) {
            debugLog("scrub:immediate-seek", {
              segmentIndex: targetIndex,
              clipPosition: info.clipPosition,
              visibleSlotIndex: slot,
            });
          }
          const ref = videoRefs[slot]?.current;
          if (!ref) return;
          ref
            .setPositionAsync(sec * 1000, {
              toleranceMillisBefore: 0,
              toleranceMillisAfter: 0,
            })
            .catch(() => {});
        } else if (typeof __DEV__ !== "undefined" && __DEV__) {
          debugLog("scrub:immediate-seek-skip", {
            reason: "throttled",
            segmentIndex: targetIndex,
          });
        }
      } else {
        // DIFFERENT SEGMENT: defer seek until after render so we target the newly mounted visible player
        if (__DEV__) {
          debugLog("scrub:deferred-cross-segment", {
            from: currentIndex,
            to: targetIndex,
            clipPosition: info.clipPosition,
          });
        }
        setCurrentSegmentIndex(targetIndex);
        pendingSeekRef.current = { segmentIndex: targetIndex, clipPosition: info.clipPosition };
      }
    }
    if (isScrubbingRef.current) {
      scrubRafRef.current = requestAnimationFrame(applyScrubFrame);
    }
  };

  const scheduleScrubFrame = () => {
    if (scrubRafRef.current != null) return;
    scrubRafRef.current = requestAnimationFrame(applyScrubFrame);
  };

  useEffect(() => {
    return () => {
      if (scrubRafRef.current != null) cancelAnimationFrame(scrubRafRef.current);
      scrubRafRef.current = null;
    };
  }, []);

  // Defer scrub seek until after render so we always seek the currently mounted visible player
  useEffect(() => {
    if (!isScrubbing) return;
    const pending = pendingSeekRef.current;
    if (!pending) return;
    if (pending.segmentIndex !== currentSegmentIndex) return;
    const item = playList[currentSegmentIndex];
    if (!item?.uri) return;
    const sec = seekSecForScrub(item, pending.clipPosition);
    const ref = videoRefs[visibleSlotIndex]?.current;
    if (!ref) return;
    ref
      .setPositionAsync(sec * 1000, {
        toleranceMillisBefore: 0,
        toleranceMillisAfter: 0,
      })
      .catch(() => {});
    pendingSeekRef.current = null;
  }, [currentSegmentIndex, visibleSlotIndex, isScrubbing, playList]);

  // Pause slot when its URI changes so stale decoder state is not left playing
  useEffect(() => {
    const nextUris = Array.from({ length: NUM_VIDEO_SLOTS }, (_, slot) => {
      const segIdx = getSegmentIndexForPlaybackSlot(slot);
      return playList[segIdx]?.uri ?? "";
    });
    nextUris.forEach((uri, slot) => {
      if (prevSlotUrisRef.current[slot] !== uri) {
        const ref = videoRefs[slot]?.current;
        if (!ref) return;
        ref.pauseAsync().catch(() => {});
      }
    });
    prevSlotUrisRef.current = nextUris;
  }, [currentSegmentIndex, visiblePlaybackSlot, playList]);

  // Log unhandled JS errors and promise rejections. If the app still crashes with no log, it's
  // likely a native crash (expo-av / OS). To see it: run from Xcode (iOS) or Android Studio,
  // or: npx react-native log-ios / npx react-native log-android, and check device crash logs.
  useEffect(() => {
    const g = global as unknown as {
      ErrorUtils?: { setGlobalHandler: (h: (e: unknown, isFatal: boolean) => void) => void; getGlobalHandler?: () => (e: unknown, isFatal: boolean) => void };
      onunhandledrejection?: (reason: unknown) => void;
      unhandledRejection?: (reason: unknown) => void;
    };
    let previousHandler: ((e: unknown, isFatal: boolean) => void) | undefined;
    if (g.ErrorUtils?.setGlobalHandler) {
      previousHandler = g.ErrorUtils.getGlobalHandler?.();
      g.ErrorUtils.setGlobalHandler((error: unknown, isFatal: boolean) => {
        console.error("[Preview] Uncaught error (global handler)", isFatal, error);
        previousHandler?.(error, isFatal);
      });
    }
    const onRejection = (reason: unknown) => {
      console.error("[Preview] Unhandled promise rejection", reason);
    };
    if (typeof g.onunhandledrejection !== "undefined") g.onunhandledrejection = onRejection;
    if (typeof g.unhandledRejection !== "undefined") g.unhandledRejection = onRejection;
    return () => {
      if (g.ErrorUtils?.setGlobalHandler && previousHandler) {
        g.ErrorUtils.setGlobalHandler(previousHandler);
      }
      if (g.onunhandledrejection === onRejection) g.onunhandledrejection = undefined;
      if (g.unhandledRejection === onRejection) g.unhandledRejection = undefined;
    };
  }, []);

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
    try {
      const now = Date.now();
      if (now - lastAdvanceAtRef.current < ADVANCE_DEBOUNCE_MS) {
        return;
      }
      lastAdvanceAtRef.current = now;
      const fromIndex = currentIndexRef.current;
      const fromVisibleSlot = visiblePlaybackSlotRef.current;
      const destinationIndex = nextIndex >= playList.length ? 0 : nextIndex;
      const nextSeg = playList[destinationIndex];
      if (!nextSeg) return;
      const nextVisibleSlot = (visiblePlaybackSlotRef.current + 1) % 3;
      visiblePlaybackSlotRef.current = nextVisibleSlot;
      setVisiblePlaybackSlot(nextVisibleSlot);
      currentIndexRef.current = destinationIndex;
      segmentBoundsRef.current = {
        startTime: nextSeg.startTime,
        endTime: nextSeg.endTime,
      };
      setPlayheadTime(nextSeg.startTime);
      segmentStartTimeRef.current = Date.now() / 1000;
      debugLog("advanceTo-sync", {
        destinationIndex,
        startTime: nextSeg.startTime,
        endTime: nextSeg.endTime,
      });

      const fromSlot = currentVisibleSlotRef.current;
      const fromRef = videoRefs[fromSlot]?.current;
      if (fromRef) {
        fromRef.pauseAsync().catch((e: unknown) => {
          console.warn("[Preview] advanceTo: pause current video failed", e);
        });
      }
      if (destinationIndex === 0 && nextIndex >= playList.length) {
        debugLog("advanceTo", { fromIndex, toIndex: 0, loop: true });
        soundRef.current?.setPositionAsync(0).catch(() => {});
        setCurrentSegmentIndex(0);
        return;
      }
      debugLog("advanceTo", { fromIndex, toIndex: destinationIndex });
      debugLog("playback-slot-advance", {
        fromVisibleSlot,
        toVisibleSlot: nextVisibleSlot,
        destinationIndex,
      });
      setCurrentSegmentIndex(destinationIndex);

      const farSlot = (nextVisibleSlot + 2) % 3;
      const preloadIndex = destinationIndex + 2;
      const preloadSeg = playList[preloadIndex];
      if (preloadSeg?.uri) {
        if (__DEV__) {
          debugLog("playback-slot-preload", {
            farSlot,
            preloadIndex,
          });
        }
        const preloadRef = videoRefs[farSlot]?.current;
        if (preloadRef) {
          preloadRef.setPositionAsync(clampToFileDuration(preloadSeg.uri, preloadSeg.clipStart) * 1000).catch(() => {});
        }
      }
    } catch (e) {
      console.error("[Preview] advanceTo crashed", e);
      if (__DEV__) Alert.alert("Preview error", `advanceTo: ${String(e)}`);
    }
  };

  const onPlaybackStatusUpdate =
    (slot: number) => (status: AVPlaybackStatus) => {
      try {
        if (!status.isLoaded || playList.length === 0 || isScrubbing) return;
        if (slot !== currentVisibleSlotRef.current) return;

        const idx = currentIndexRef.current;
        const seg = playList[idx];
        if (!seg || !seg.uri) return;
        const position = status.positionMillis / 1000;
        const durationMillis = status.durationMillis ?? 0;
        const durationSec = durationMillis / 1000;
        const didJustFinish = "didJustFinish" in status && (status as AVPlaybackStatus & { didJustFinish?: boolean }).didJustFinish === true;
        if (durationSec > 0) fileDurationByUriRef.current[seg.uri] = durationSec;
        const totalElapsed = Date.now() / 1000 - segmentStartTimeRef.current;
        setPlayheadTime(seg.startTime + Math.min(totalElapsed, seg.segmentDuration));

        const fileDur = fileDurationByUriRef.current[seg.uri];
        const effectiveClipEnd = fileDur != null && fileDur > 0
          ? Math.min(seg.clipEnd, fileDur - 0.05)
          : seg.clipEnd;
        const atClipEnd = position >= effectiveClipEnd - 0.06;
        const atNaturalEnd = didJustFinish || (durationSec > 0 && position >= durationSec - 0.1);
        const segmentDone =
          totalElapsed >= seg.segmentDuration - 0.08 || atClipEnd || atNaturalEnd;

        if (segmentDone) {
          if (__DEV__) debugLog("segment-done", { idx });
          advanceTo(idx + 1);
          return;
        }

        if (seg.segmentDuration <= seg.clipDuration) {
          return;
        }

        if (atClipEnd || atNaturalEnd) {
          const now = Date.now();
          if (loopSeekInFlightRef.current[slot]) {
            if (__DEV__) debugLog("manual-loop-seek-skip", { reason: "in-flight", slot, idx });
            return;
          }
          if ((lastLoopSeekAtRef.current[slot] ?? 0) > now - 250) {
            if (__DEV__) debugLog("manual-loop-seek-skip", { reason: "too-recent", slot, idx });
            return;
          }

          loopSeekInFlightRef.current[slot] = true;
          lastLoopSeekAtRef.current[slot] = now;
          const seekSec = fileDur != null ? Math.min(seg.clipStart, fileDur - 0.05) : seg.clipStart;
          if (__DEV__) {
            debugLog("loop-clip", {
              slot,
              idx,
              clipStart: seg.clipStart,
              clipEnd: seg.clipEnd,
              position,
              effectiveClipEnd,
              segmentDuration: seg.segmentDuration,
              clipDuration: seg.clipDuration,
            });
          }
          const ref = videoRefs[slot]?.current;
          if (!ref) {
            loopSeekInFlightRef.current[slot] = false;
            return;
          }
          ref
            .setPositionAsync(seekSec * 1000)
            .catch(() => {})
            .finally(() => {
              loopSeekInFlightRef.current[slot] = false;
            });
        }
      } catch (e) {
        console.error("[Preview] onPlaybackStatusUpdate crashed", e);
        if (__DEV__) Alert.alert("Preview error", `onPlaybackStatusUpdate: ${String(e)}`);
      }
    };

  const seg = playList[currentSegmentIndex];

  useEffect(() => {
    loopSeekInFlightRef.current = {};
    lastLoopSeekAtRef.current = {};
  }, [currentSegmentIndex]);

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
    try {
      const info = getSegmentAtTime(playheadTime);
      const inSegment = info && info.segmentIndex === currentSegmentIndex;
      const startSec = inSegment ? info!.clipPosition : seg.clipStart;
      const startSecClamped = clampToFileDuration(seg.uri, startSec);
      segmentStartTimeRef.current = Date.now() / 1000 - (inSegment ? playheadTime - seg.startTime : 0);
      if (seg.uri) {
        const activeRef = videoRefs[visibleSlotIndex]?.current;
        const startMs = startSecClamped * 1000;
        const logErr = (tag: string) => (e: unknown) => {
          console.warn(`[Preview] ${tag}`, e);
        };
        if (activeRef?.playFromPositionAsync) {
          activeRef.playFromPositionAsync(startMs).catch(logErr("playFromPositionAsync"));
        } else {
          activeRef?.setPositionAsync(startMs).catch(logErr("setPositionAsync"));
          activeRef?.playAsync().catch(logErr("playAsync"));
        }
      }
      const nextSlot = getPlaybackSlotForRelativeOffset(1, visiblePlaybackSlot);
      const nextNextSlot = getPlaybackSlotForRelativeOffset(2, visiblePlaybackSlot);
      const nextItem = playList[currentSegmentIndex + 1];
      const nextNextItem = playList[currentSegmentIndex + 2];
      if (nextItem?.uri) {
        const nextStart = clampToFileDuration(nextItem.uri, nextItem.clipStart);
        const nextRef = videoRefs[nextSlot]?.current;
        if (nextRef) nextRef.setPositionAsync(nextStart * 1000).catch(() => {});
      }
      if (nextNextItem?.uri) {
        const nextNextStart = clampToFileDuration(nextNextItem.uri, nextNextItem.clipStart);
        const nnRef = videoRefs[nextNextSlot]?.current;
        if (nnRef) nnRef.setPositionAsync(nextNextStart * 1000).catch(() => {});
      }
    } catch (e) {
      console.error("[Preview] segment sync effect crashed", e);
      if (__DEV__) Alert.alert("Preview error", `Segment sync: ${String(e)}`);
    }
  }, [currentSegmentIndex, playList, visibleSlotIndex, visiblePlaybackSlot, isScrubbing, isPlaying]);

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
              const ref = videoRefs[visibleSlotIndex]?.current;
              if (ref) ref.pauseAsync().catch(() => {});
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
            {Array.from({ length: 3 }, (_, slot) => {
              const segmentIndex = getSegmentIndexForPlaybackSlot(slot);
              const item = playList[segmentIndex];
              const isVisible = slot === visiblePlaybackSlot;
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
            pendingScrubTimeRef.current = t;
            if (isScrubbingRef.current) scheduleScrubFrame();
            else {
              applyScrubFrame();
            }
          }}
          onSegmentsChange={(next) => setSegments((_prev) => next)}
          selectedSegmentIndex={selectedSegmentIndex}
          onResizeStart={() => {
            isResizingRef.current = true;
          }}
          onResizeEnd={() => {
            isResizingRef.current = false;
            setSegments((prev) => [...prev]);
          }}
          onSelectSegment={(i) => {
            setSelectedSegmentIndex(i);
            const t = playheadTimeRef.current;
            const info = getSegmentAtTime(t);
            if (info !== null) {
              setCurrentSegmentIndex(info.segmentIndex);
              pendingSeekRef.current = { segmentIndex: info.segmentIndex, clipPosition: info.clipPosition };
              soundRef.current?.setPositionAsync(t * 1000).catch(() => {});
            }
          }}
          thumbnailUris={thumbnailUris}
          thumbnailFrameUris={thumbnailFrameUris}
          onScrubbingChange={(scrubbing) => {
            isScrubbingRef.current = scrubbing;
            setIsScrubbing(scrubbing);
            if (scrubbing) {
              const ref = videoRefs[visibleSlotIndex]?.current;
              if (ref) ref.pauseAsync().catch(() => {});
              soundRef.current?.pauseAsync().catch(() => {});
            } else {
              if (scrubRafRef.current != null) cancelAnimationFrame(scrubRafRef.current);
              scrubRafRef.current = null;
              if (isPlaying) soundRef.current?.playAsync().catch(() => {});
            }
          }}
          timelineScrollX={timelineScrollX}
          onTimelineScrollChange={setTimelineScrollX}
          timelineViewportWidth={timelineViewportWidth}
          onTimelineViewportLayout={setTimelineViewportWidth}
          timelineScrollRef={timelineScrollRef}
          resizeMode={resizeMode}
          secondsPerViewport={secondsPerViewport}
          onSecondsPerViewportChange={setSecondsPerViewport}
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
