import React, { useEffect, useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Alert, Image, Dimensions, ScrollView } from "react-native";
import { Video, ResizeMode, AVPlaybackStatus, Audio } from "expo-av";
let VideoThumbnails: typeof import("expo-video-thumbnails") | null = null;
try {
  VideoThumbnails = require("expo-video-thumbnails");
} catch {
  // Optional: run npx expo install expo-video-thumbnails
}
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { SERVER_URL } from "../config";
import { useAnalyze } from "../context/AnalyzeContext";
import TimelineStrip from "../components/TimelineStrip";
import ClipSelectionModal from "../components/ClipSelectionModal";

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");
const PREVIEW_AREA_HEIGHT = Math.round(SCREEN_HEIGHT * 0.38);
const PREVIEW_CARD_WIDTH_RATIO = 0.6;
const PREVIEW_ASPECT_RATIO = 9 / 16;
const PREVIEW_CARD_BORDER_RADIUS = 28;
const PREVIEW_MARGIN_H = 24;
const PREVIEW_MARGIN_V = 12;
const PREVIEW_WIDTH = Math.round(SCREEN_WIDTH * PREVIEW_CARD_WIDTH_RATIO);
const PREVIEW_HEIGHT = Math.min(
  Math.round(PREVIEW_WIDTH / PREVIEW_ASPECT_RATIO),
  PREVIEW_AREA_HEIGHT - PREVIEW_MARGIN_V * 2
);
const STRIP_HEIGHT = 48;
const BLOCK_GAP = 4;
const BLOCK_BORDER_RADIUS = 6;
const RESIZE_EDGE_WIDTH = 28;
const SCRUB_HIT_SLOP = 24; // only move playhead when touch is within this many px of the line
const EPSILON = 0.01; // 10ms; used for float-safe boundary comparisons
const MIN_SEEK_DELTA = 1 / 30; // ~33ms; only seek when timeline time changes by more than this
const FPS = 30;
const FRAME = 1 / FPS;

function quantizeToFrame(time: number): number {
  return Math.round(time * FPS) / FPS;
}

// Time-based thumbnail density: one frame every THUMBNAIL_INTERVAL_SEC, clamped by MAX_THUMBNAILS_PER_CLIP.
// MIN_CLIP_DURATION is also used when clamping very short clips during resize logic.
const THUMBNAIL_INTERVAL_SEC = 0.5;
const MAX_THUMBNAILS_PER_CLIP = 20;
const MIN_CLIP_DURATION = 0.1;
// Target extraction resolution for timeline thumbnails (expo-video-thumbnails does not support width/height; quality only).
// If migrating to expo-video generateThumbnailsAsync, add maxWidth/maxHeight.
const THUMBNAIL_EXTRACT_WIDTH = 96;
const THUMBNAIL_EXTRACT_HEIGHT = 54;
const THUMBNAIL_EXTRACT_QUALITY = 0.25;

function thumbnailCacheKey(uri: string, timeSec: number): string {
  return `${uri}::${timeSec.toFixed(3)}::w${THUMBNAIL_EXTRACT_WIDTH}::h${THUMBNAIL_EXTRACT_HEIGHT}::q${THUMBNAIL_EXTRACT_QUALITY}`;
}

function debugLog(tag: string, data?: object) {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.log("[Preview]", tag, data ?? "");
  }
}

// In-memory performance log buffer (DEV only). Capped ring buffer for export/debugging.
const PERF_LOG_CAP = 400;
type PerfLogEntry = { ts: number; event: string; payload?: Record<string, unknown>; repeat?: number };
const perfLogBuffer: PerfLogEntry[] = [];
let perfLogLast: { event: string; payloadKey: string } | null = null;
let perfLogRepeat = 0;

function perfLog(event: string, payload?: Record<string, unknown>) {
  if (typeof __DEV__ === "undefined" || !__DEV__) return;
  const ts = Date.now() / 1000;
  const payloadKey = JSON.stringify(payload ?? {});
  if (perfLogLast?.event === event && perfLogLast?.payloadKey === payloadKey) {
    perfLogRepeat++;
    return;
  }
  if (perfLogRepeat > 0 && perfLogBuffer.length > 0) {
    const prev = perfLogBuffer[perfLogBuffer.length - 1];
    if (prev.event === perfLogLast?.event) prev.repeat = perfLogRepeat;
  }
  perfLogRepeat = 0;
  perfLogLast = { event, payloadKey };
  const entry: PerfLogEntry = { ts, event, payload };
  if (perfLogBuffer.length >= PERF_LOG_CAP) perfLogBuffer.shift();
  perfLogBuffer.push(entry);
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
  const { analyzeResult, mediaList, songUri, setMediaListForPreview, setPendingExportSegments, exportSegmentsRef } = useAnalyze();
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
  const [playbackEnded, setPlaybackEnded] = useState(false);
  const [selectedSegmentIndex, setSelectedSegmentIndex] = useState<number | null>(null);
  const [replaceSelectionPending, setReplaceSelectionPending] = useState<{ uri: string; filename: string } | null>(null);
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
  const timelineTimeRef = useRef(0);
  const lastFrameTimeRef = useRef(performance.now());
  const rafRef = useRef<number | null>(null);
  const isPlayingRef = useRef(false);
  isPlayingRef.current = isPlaying;
  const pendingScrubTimeRef = useRef<number | null>(null);
  const pendingSeekRef = useRef<{ segmentIndex: number; clipPosition: number } | null>(null);
  const scrubRafRef = useRef<number | null>(null);
  const isScrubbingRef = useRef(false);
  const isResizingRef = useRef(false);
  const lastImmediateScrubSeekAtRef = useRef(0);
  const lastScrubSeekTimeRef = useRef<number>(0);
  const prevSlotUrisRef = useRef<string[]>([]);
  const loopSeekInFlightRef = useRef<Record<number, boolean>>({});
  const lastLoopSeekAtRef = useRef<Record<number, number>>({});
  const finishedSegmentsRef = useRef<Set<number>>(new Set());
  const advanceInFlightRef = useRef(false);
  const slotSeekTokenRef = useRef<number[]>([0, 0, 0]);
  // Thumbnail cache by unified key (uri::time::w::h::q). In-flight deduplication for concurrent identical requests.
  const thumbnailCacheRef = useRef<Map<string, string>>(new Map());
  const thumbnailInflightRef = useRef<Map<string, Promise<string>>>(new Map());
  const prevViewportRef = useRef<{ first: number; last: number } | null>(null);
  const thumbnailQueueRef = useRef<{ segmentIndex: number; time: number }[]>([]);
  const thumbnailWorkerCancelRef = useRef(false);
  const thumbnailWorkerRunningRef = useRef(false);
  const segmentsRef = useRef<SegmentRecord[]>([]);
  // Editable segments: source of truth for timeline; initialized from analyze result, updated on resize
  const [segments, setSegments] = useState<SegmentRecord[]>([]);
  segmentsRef.current = segments;
  const segmentsInitialized = useRef(false);
  useEffect(() => {
    if (analyzeResult) {
      const segs = analyzeResult.segments;
      const first = Array.isArray(segs) && segs.length ? segs[0] : null;
      const cuts = analyzeResult.cut_points;
      const firstCut = Array.isArray(cuts) && cuts.length ? cuts[0] : null;
      console.log("[TRACE] preview: received analyzeResult", {
        duration: analyzeResult.duration,
        bpm: analyzeResult.bpm,
        segmentCount: Array.isArray(segs) ? segs.length : 0,
        firstSegmentStart: first != null && typeof first === "object" && "startTime" in first ? (first as { startTime?: number }).startTime : undefined,
        firstCut,
      });
    }
  }, [analyzeResult]);
  useEffect(() => {
    const raw = analyzeResult?.segments as Record<string, unknown>[] | undefined;
    if (raw?.length && !segmentsInitialized.current) {
      const mapped = raw.map((s) => {
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
      });
      // Guarantee clip boundary continuity: seg[i].end === seg[i+1].start
      const d0 = mapped[0].endTime - mapped[0].startTime;
      mapped[0].startTime = 0;
      mapped[0].endTime = d0;
      for (let i = 1; i < mapped.length; i++) {
        const dur = mapped[i].endTime - mapped[i].startTime;
        mapped[i].startTime = mapped[i - 1].endTime;
        mapped[i].endTime = mapped[i].startTime + dur;
      }
      setSegments(mapped);
      segmentsInitialized.current = true;
    }
  }, [analyzeResult?.segments]);

  useEffect(() => {
    finishedSegmentsRef.current.clear();
  }, [segments.length]);

  const totalDuration =
    segments.length > 0 ? segments[segments.length - 1].endTime : (analyzeResult?.duration ?? 0);
  const totalDurationRef = useRef(totalDuration);
  totalDurationRef.current = totalDuration;

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

  const playListRef = useRef<PlayItem[]>(playList);
  playListRef.current = playList;

  const getPlaybackSlotForRelativeOffset = (offset: number, base: number) => (base + offset) % 3;
  const visibleSlotIndex = visiblePlaybackSlot;
  currentVisibleSlotRef.current = visibleSlotIndex;

  const getSegmentIndexForPlaybackSlot = (slot: number) =>
    currentSegmentIndex + ((slot - visiblePlaybackSlot + NUM_VIDEO_SLOTS) % NUM_VIDEO_SLOTS);

  const THUMBNAIL_REQUEST_DELAY_MS = 120;
  const VIEWPORT_DEBOUNCE_MS = 80;

  // Pass 1: One thumbnail per clip at segment midpoint, so every clip has at least one frame quickly.
  useEffect(() => {
    if (!playList.length || !VideoThumbnails) return;
    if (isResizingRef.current) return;
    let cancelled = false;
    const cache = thumbnailCacheRef.current;
    const inflight = thumbnailInflightRef.current;
    const listLength = playList.length;
    (async () => {
      for (let i = 0; i < listLength; i++) {
        if (cancelled) break;
        const item = playList[i];
        if (!item?.uri) continue;
        const midTime = (item.startTime + item.endTime) / 2;
        const info = getSegmentAtTime(midTime);
        if (!info || info.segmentIndex !== i) continue;
        const key = thumbnailCacheKey(item.uri, info.clipPosition);
        if (cache.get(key)) continue;
        let promise = inflight.get(key);
        if (promise) {
          try {
            await promise;
          } catch {
            // ignore
          }
          continue;
        }
        promise = VideoThumbnails!.getThumbnailAsync(item.uri, {
          time: Math.round(info.clipPosition * 1000),
          quality: THUMBNAIL_EXTRACT_QUALITY,
        })
          .then((res) => {
            if (res.uri) cache.set(key, res.uri);
            inflight.delete(key);
            return res.uri ?? "";
          })
          .catch((err) => {
            inflight.delete(key);
            throw err;
          });
        inflight.set(key, promise);
        try {
          await promise;
        } catch {
          // leave uncached
        }
      }
      if (cancelled) return;
      setThumbnailFrameUris((prev) => {
        const next = Array.from({ length: listLength }, (_, i) => (prev[i] ? prev[i].slice() : []));
        for (let i = 0; i < listLength; i++) {
          const item = playList[i];
          if (!item?.uri) continue;
          const midTime = (item.startTime + item.endTime) / 2;
          const info = getSegmentAtTime(midTime);
          if (!info) continue;
          const uri = cache.get(thumbnailCacheKey(item.uri, info.clipPosition));
          if (uri && (!next[i] || next[i].length === 0)) next[i] = [uri];
        }
        return next;
      });
      setThumbnailUris((prev) => {
        const next = Array.from({ length: listLength }, (_, i) => prev[i] ?? null);
        for (let i = 0; i < listLength; i++) {
          const item = playList[i];
          if (!item?.uri) continue;
          const midTime = (item.startTime + item.endTime) / 2;
          const info = getSegmentAtTime(midTime);
          if (!info) continue;
          const uri = cache.get(thumbnailCacheKey(item.uri, info.clipPosition));
          if (uri && !next[i]) next[i] = uri;
        }
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [playList]);

  // Pass 2: Full thumbnail generation with viewport-priority queue; no cancellation on viewport change.
  useEffect(() => {
    if (!playList.length || !VideoThumbnails) return;
    if (isResizingRef.current) {
      debugLog("thumbnails:skip-resizing");
      if (__DEV__) perfLog("thumbnails:skip-resizing", {});
      return;
    }

    thumbnailWorkerCancelRef.current = false;
    let viewportDebounceId: ReturnType<typeof setTimeout> | undefined;

    const buildQueueForSegment = (segmentIndex: number): { segmentIndex: number; time: number }[] => {
      const item = playList[segmentIndex];
      if (!item?.uri) return [];
      const cache = thumbnailCacheRef.current;
      const out: { segmentIndex: number; time: number }[] = [];
      let count = 0;
      for (let t = item.startTime; t < item.endTime && count < MAX_THUMBNAILS_PER_CLIP; t += THUMBNAIL_INTERVAL_SEC) {
        const info = getSegmentAtTime(t);
        if (!info || info.segmentIndex !== segmentIndex) continue;
        const key = thumbnailCacheKey(item.uri, info.clipPosition);
        if (!cache.get(key)) out.push({ segmentIndex, time: t });
        count++;
      }
      return out;
    };

    const runWorker = async () => {
      if (thumbnailWorkerRunningRef.current) return;
      thumbnailWorkerRunningRef.current = true;
      const cache = thumbnailCacheRef.current;
      const inflight = thumbnailInflightRef.current;
      const listLength = playList.length;
      try {
        while (!thumbnailWorkerCancelRef.current && thumbnailQueueRef.current.length > 0) {
          const item = thumbnailQueueRef.current.shift();
          if (!item) continue;
          const segItem = playList[item.segmentIndex];
          if (!segItem?.uri) continue;
          const info = getSegmentAtTime(item.time);
          if (!info || info.segmentIndex !== item.segmentIndex) continue;
          const key = thumbnailCacheKey(segItem.uri, info.clipPosition);
          if (cache.get(key)) continue;
          let promise = inflight.get(key);
          if (promise) {
            try {
              await promise;
            } catch {
              // ignore
            }
            continue;
          }
          promise = VideoThumbnails!.getThumbnailAsync(segItem.uri, {
            time: Math.round(info.clipPosition * 1000),
            quality: THUMBNAIL_EXTRACT_QUALITY,
          })
            .then((res) => {
              if (res.uri) cache.set(key, res.uri);
              inflight.delete(key);
              return res.uri ?? "";
            })
            .catch((err) => {
              inflight.delete(key);
              throw err;
            });
          inflight.set(key, promise);
          try {
            await promise;
          } catch {
            // leave uncached
          }
          if (thumbnailWorkerCancelRef.current) break;
          setThumbnailFrameUris((prev) => {
            const next = prev.slice();
            const frames: (string | null)[] = [];
            const seg = playList[item.segmentIndex];
            if (seg) {
              for (let t = seg.startTime; t < seg.endTime; t += THUMBNAIL_INTERVAL_SEC) {
                const si = getSegmentAtTime(t);
                if (!si || !playList[si.segmentIndex]?.uri) {
                  frames.push(null);
                  continue;
                }
                const k = thumbnailCacheKey(playList[si.segmentIndex].uri!, si.clipPosition);
                frames.push(cache.get(k) ?? null);
              }
            }
            next[item.segmentIndex] = frames;
            return next;
          });
          setThumbnailUris((prev) => {
            const next = prev.slice();
            const seg = playList[item.segmentIndex];
            if (seg) {
              const frames: (string | null)[] = [];
              for (let t = seg.startTime; t < seg.endTime; t += THUMBNAIL_INTERVAL_SEC) {
                const si = getSegmentAtTime(t);
                if (!si || !playList[si.segmentIndex]?.uri) continue;
                const k = thumbnailCacheKey(playList[si.segmentIndex].uri!, si.clipPosition);
                const u = cache.get(k);
                if (u) {
                  next[item.segmentIndex] = u;
                  return next;
                }
              }
            }
            return next;
          });
          const more = buildQueueForSegment(item.segmentIndex);
          if (more.length > 0) thumbnailQueueRef.current.push(...more);
          if (THUMBNAIL_REQUEST_DELAY_MS > 0) {
            await new Promise((r) => setTimeout(r, THUMBNAIL_REQUEST_DELAY_MS));
          }
        }
      } finally {
        thumbnailWorkerRunningRef.current = false;
      }
    };

    viewportDebounceId = setTimeout(() => {
      if (isResizingRef.current) return;
      const listLength = playList.length;
      const n = segments.length;
      const STRIP_BLOCK_GAP = 0;
      const contentWidth = totalDuration > 0 && n > 0 ? stripWidth - (n - 1) * STRIP_BLOCK_GAP : 0;
      const leftEdges: number[] = [];
      const blockWidths: number[] = [];
      if (n > 0 && totalDuration > 0) {
        for (let i = 0; i < n; i++) {
          const seg = segments[i];
          blockWidths.push(((seg.endTime - seg.startTime) / totalDuration) * contentWidth);
        }
        let x = 0;
        for (let i = 0; i < n; i++) {
          leftEdges.push(x);
          x += blockWidths[i] + STRIP_BLOCK_GAP;
        }
      }
      const viewStart = timelineScrollX;
      const viewEnd = timelineScrollX + timelineViewportWidth;
      let firstVisibleIndex = -1;
      let lastVisibleIndex = -1;
      for (let i = 0; i < leftEdges.length; i++) {
        const clipStart = leftEdges[i];
        const clipEnd = clipStart + (blockWidths[i] ?? 0);
        if (clipStart < viewEnd && clipEnd > viewStart) {
          if (firstVisibleIndex < 0) firstVisibleIndex = i;
          lastVisibleIndex = i;
        }
      }
      const firstTarget = firstVisibleIndex < 0 ? 0 : Math.max(0, firstVisibleIndex - 2);
      const lastTarget = lastVisibleIndex < 0 ? -1 : Math.min(listLength - 1, lastVisibleIndex + 2);
      prevViewportRef.current = { first: firstTarget, last: lastTarget };
      if (__DEV__) {
        debugLog("thumbnails:viewport-range", { first: firstTarget, last: lastTarget });
        perfLog("thumbnails:viewport-range", { first: firstTarget, last: lastTarget });
      }
      const viewportItems: { segmentIndex: number; time: number }[] = [];
      const restItems: { segmentIndex: number; time: number }[] = [];
      for (let i = 0; i < listLength; i++) {
        const items = buildQueueForSegment(i);
        if (i >= firstTarget && i <= lastTarget) viewportItems.push(...items);
        else restItems.push(...items);
      }
      thumbnailQueueRef.current = [...viewportItems, ...restItems];
      runWorker();
    }, VIEWPORT_DEBOUNCE_MS);

    return () => {
      thumbnailWorkerCancelRef.current = true;
      if (viewportDebounceId != null) clearTimeout(viewportDebounceId);
    };
  }, [playList, segments, totalDuration, stripWidth, timelineScrollX, timelineViewportWidth]);

  const lastRenderPassLogRef = useRef(0);
  useEffect(() => {
    if (typeof __DEV__ === "undefined" || !__DEV__) return;
    const now = Date.now();
    if (now - lastRenderPassLogRef.current < 2000) return;
    lastRenderPassLogRef.current = now;
    perfLog("preview:render-pass", { currentSegmentIndex });
  }, [currentSegmentIndex]);

  // Map global time (0..duration) to segment index and in-clip position
  const getSegmentAtTime = (t: number): { segmentIndex: number; offsetInSegment: number; clipPosition: number } | null => {
    if (!playList.length || t < 0) return null;
    for (let i = 0; i < playList.length; i++) {
      const item = playList[i];
      if (t >= item.startTime - EPSILON && t < item.endTime - EPSILON) {
        const offsetInSegment = t - item.startTime;
        const clipPosition = item.clipStart + offsetInSegment;
        return { segmentIndex: i, offsetInSegment, clipPosition };
      }
    }
    const last = playList[playList.length - 1];
    if (t >= last.endTime - EPSILON)
      return { segmentIndex: playList.length - 1, offsetInSegment: last.segmentDuration, clipPosition: last.clipEnd };
    return null;
  };

  /** Insert a cut at the current playhead; total duration unchanged. No-op if playhead not inside a segment or would create zero-length segment. */
  const addCutAtPlayhead = () => {
    const t = timelineTimeRef.current;
    if (segments.length === 0) return;
    const segDurMin = 0.05;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (t <= seg.startTime + segDurMin || t >= seg.endTime - segDurMin) continue;
      const offsetInSegment = t - seg.startTime;
      const segmentDuration = seg.endTime - seg.startTime;
      const clipDuration = Math.max(segDurMin, (seg.clipEnd ?? seg.clipStart) - seg.clipStart);
      const clipPosition = seg.clipStart + (offsetInSegment / segmentDuration) * clipDuration;
      const left: SegmentRecord = {
        startTime: seg.startTime,
        endTime: t,
        clipFilename: seg.clipFilename,
        clipStart: seg.clipStart,
        clipEnd: clipPosition,
      };
      const right: SegmentRecord = {
        startTime: t,
        endTime: seg.endTime,
        clipFilename: seg.clipFilename,
        clipStart: clipPosition,
        clipEnd: seg.clipEnd ?? seg.clipStart + clipDuration,
      };
      const next = [...segments.slice(0, i), left, right, ...segments.slice(i + 1)];
      setSegments(next);
      setCurrentSegmentIndex(i);
      if (__DEV__) debugLog("add-cut-at-playhead", { playheadTime: t, segmentIndex: i, newSegments: next.length });
      return;
    }
  };

  /** Replace the selected segment's clip. Keeps timeline span. If clipStart/clipEnd provided, use them; otherwise 0..segmentDuration (or trim if file shorter). */
  const replaceSegmentWith = (
    media: { uri: string; filename?: string },
    clipStart?: number,
    clipEnd?: number
  ) => {
    const idx = selectedSegmentIndex;
    if (idx == null || idx < 0 || idx >= segments.length) return;
    const seg = segments[idx];
    const segmentDuration = seg.endTime - seg.startTime;
    const fileDur = fileDurationByUriRef.current[media.uri];
    let newClipStart: number;
    let newClipEnd: number;
    if (clipStart != null && clipEnd != null) {
      newClipStart = clipStart;
      newClipEnd = clipEnd;
    } else {
      newClipStart = 0;
      newClipEnd =
        fileDur != null && fileDur > 0 && fileDur < segmentDuration
          ? Math.max(0.05, fileDur - 0.05)
          : segmentDuration;
      if (fileDur != null && fileDur > 0 && fileDur < segmentDuration) {
        Alert.alert(
          "Clip shorter",
          "Replacement video is shorter than the segment; trimmed to available length."
        );
      }
    }
    const filename = media.filename ?? "unknown";
    setSegments((prev) =>
      prev.map((s, i) =>
        i === idx ? { ...s, clipFilename: filename, clipStart: newClipStart, clipEnd: newClipEnd } : s
      )
    );
    if (__DEV__) debugLog("replace-segment", { segmentIndex: idx, filename, newClipStart, newClipEnd });
  };

  /** Remove the selected segment from the timeline. Shifts subsequent segment times. */
  const deleteSelectedSegment = () => {
    const idx = selectedSegmentIndex;
    if (idx == null || idx < 0 || idx >= segments.length) return;
    if (segments.length <= 1) {
      Alert.alert("Can't delete", "Keep at least one segment.");
      return;
    }
    const seg = segments[idx];
    const removedDuration = seg.endTime - seg.startTime;
    const next = segments
      .filter((_, i) => i !== idx)
      .map((s, i) => (i >= idx ? { ...s, startTime: s.startTime - removedDuration, endTime: s.endTime - removedDuration } : s));
    setSegments(next);
    setSelectedSegmentIndex(null);
    if (currentSegmentIndex === idx) {
      setCurrentSegmentIndex(Math.min(idx, next.length - 1));
    } else if (currentSegmentIndex > idx) {
      setCurrentSegmentIndex(currentSegmentIndex - 1);
    }
    const newTotal = next.length > 0 ? next[next.length - 1].endTime : 0;
    if (timelineTimeRef.current >= newTotal) {
      timelineTimeRef.current = Math.max(0, newTotal - 0.1);
      setPlayheadTime(timelineTimeRef.current);
    }
    if (__DEV__) debugLog("delete-segment", { index: idx, newCount: next.length });
  };

  /** Open user's media library to pick a video; add to project media and open in-clip selection modal. */
  const handleReplaceFromLibrary = async () => {
    if (selectedSegmentIndex == null) return;
    const { granted } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!granted) {
      Alert.alert("Permission required", "We need access to your gallery to select a replacement clip.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Videos,
      allowsMultipleSelection: false,
    });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    const uri = asset.uri;
    const filename = asset.fileName ?? `replacement_${Date.now()}.mp4`;
    setMediaListForPreview([...mediaList, { uri, filename }]);
    setReplaceSelectionPending({ uri, filename });
  };

  const clampToFileDuration = (uri: string | undefined, sec: number) => {
    if (!uri) return sec;
    const fileDur = fileDurationByUriRef.current[uri];
    if (fileDur == null || fileDur <= 0) return sec;
    return Math.min(sec, fileDur - 0.05);
  };

  /** Use before any video call to avoid calling on an unmounted Video ref. Returns null if ref is not mounted. */
  function getMountedVideoRef(slot: number): Video | null {
    const ref = videoRefs[slot]?.current;
    if (!ref) return null;
    return ref;
  }

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
    timelineTimeRef.current = time;
    setPlayheadTime(time);
    const targetIndex = info.segmentIndex;
    const currentIndex = currentIndexRef.current;
    if (targetIndex !== currentIndex) {
      soundRef.current?.setPositionAsync(time * 1000).catch(() => {});
      advanceTo(targetIndex, { force: true, seekToClipPosition: info.clipPosition });
    } else {
      setCurrentSegmentIndex(targetIndex);
      soundRef.current?.setPositionAsync(time * 1000).catch(() => {});
      const item = playList[targetIndex];
      if (item?.uri) {
        const slotIndex = currentVisibleSlotRef.current;
        const ref = getMountedVideoRef(slotIndex);
        if (ref) {
          const sec = seekSecForScrub(item, info.clipPosition);
          const token = ++slotSeekTokenRef.current[slotIndex];
          ref.setPositionAsync(sec * 1000).catch(() => {}).finally(() => {
            if (token !== slotSeekTokenRef.current[slotIndex] && __DEV__) debugLog("seek-token-stale", { slot: slotIndex, token });
          });
        } else if (__DEV__) debugLog("slot-ref-null", { slot: slotIndex, action: "seekToTime" });
      }
    }
  };

  const applyScrubFrame = () => {
    scrubRafRef.current = null;
    const t = pendingScrubTimeRef.current;
    if (t === null) return;
    const quantizedTime = quantizeToFrame(t);
    timelineTimeRef.current = quantizedTime;
    setPlayheadTime(quantizedTime);
    const info = getSegmentAtTime(quantizedTime);
    if (info === null) {
      if (isScrubbingRef.current) scrubRafRef.current = requestAnimationFrame(applyScrubFrame);
      return;
    }
    if (Math.abs(quantizedTime - lastScrubSeekTimeRef.current) < FRAME) {
      // if (__DEV__) debugLog("scrub:immediate-seek-skip", { reason: "frame-throttled" });
      if (isScrubbingRef.current) scrubRafRef.current = requestAnimationFrame(applyScrubFrame);
      return;
    }
    const targetIndex = info.segmentIndex;
    const currentIndex = currentIndexRef.current;
    const item = playList[targetIndex];

    // Keep audio in sync with the playhead when we seek
    soundRef.current?.setPositionAsync(quantizedTime * 1000).catch(() => {});

    if (item?.uri && targetIndex === currentIndex) {
      // SAME SEGMENT: seek the currently visible player immediately (throttled) for smooth scrubbing
      const now = Date.now();
      if (now - lastImmediateScrubSeekAtRef.current >= 16) {
        lastImmediateScrubSeekAtRef.current = now;
        lastScrubSeekTimeRef.current = quantizedTime;
        const sec = seekSecForScrub(item, info.clipPosition);
        const slot = currentVisibleSlotRef.current;
        if (__DEV__) {
          debugLog("scrub:immediate-seek", {
            segmentIndex: targetIndex,
            clipPosition: info.clipPosition,
            visibleSlotIndex: slot,
          });
        }
        const ref = getMountedVideoRef(slot);
        if (!ref) {
          if (__DEV__) debugLog("slot-ref-null", { slot, action: "scrub-same-segment" });
          if (isScrubbingRef.current) scrubRafRef.current = requestAnimationFrame(applyScrubFrame);
          return;
        }
        const token = ++slotSeekTokenRef.current[slot];
        ref
          .setPositionAsync(sec * 1000, {
            toleranceMillisBefore: 0,
            toleranceMillisAfter: 0,
          })
          .catch(() => {})
          .finally(() => {
            if (token !== slotSeekTokenRef.current[slot] && __DEV__) debugLog("seek-token-stale", { slot, token });
          });
      } else if (typeof __DEV__ !== "undefined" && __DEV__) {
        debugLog("scrub:immediate-seek-skip", {
          reason: "throttled",
          segmentIndex: targetIndex,
        });
      }
    } else {
      // DIFFERENT SEGMENT: jump with force and seek new slot to clip position
      lastScrubSeekTimeRef.current = quantizedTime;
      if (__DEV__) {
        debugLog("scrub:deferred-cross-segment", {
          from: currentIndex,
          to: targetIndex,
          clipPosition: info.clipPosition,
        });
      }
      soundRef.current?.setPositionAsync(quantizedTime * 1000).catch(() => {});
      advanceTo(targetIndex, { force: true, seekToClipPosition: info.clipPosition });
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

  // Defer scrub seek until after render (e.g. onSelectSegment sets pendingSeekRef)
  useEffect(() => {
    if (!isScrubbing) return;
    const pending = pendingSeekRef.current;
    if (!pending) return;
    if (pending.segmentIndex !== currentSegmentIndex) return;
    const item = playList[currentSegmentIndex];
    if (!item?.uri) return;
    const sec = seekSecForScrub(item, pending.clipPosition);
    const ref = getMountedVideoRef(visibleSlotIndex);
    if (!ref) {
      if (__DEV__) debugLog("slot-ref-null", { slot: visibleSlotIndex, action: "deferred-seek" });
      return;
    }
    const timelineTime = item.startTime + (pending.clipPosition - item.clipStart);
    const token = ++slotSeekTokenRef.current[visibleSlotIndex];
    ref
      .setPositionAsync(sec * 1000, {
        toleranceMillisBefore: 0,
        toleranceMillisAfter: 0,
      })
      .catch(() => {})
      .finally(() => {
        if (token !== slotSeekTokenRef.current[visibleSlotIndex] && __DEV__) debugLog("seek-token-stale", { slot: visibleSlotIndex, token });
      });
    lastScrubSeekTimeRef.current = quantizeToFrame(timelineTime);
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
        const ref = getMountedVideoRef(slot);
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

  const advanceTo = (nextIndex: number, options?: { force?: boolean; seekToClipPosition?: number }) => {
    if (advanceInFlightRef.current) return;
    advanceInFlightRef.current = true;
    const fromIndex = currentIndexRef.current;
    try {
      if (nextIndex < 0 || nextIndex >= playList.length) {
        if (nextIndex >= playList.length) {
          // Final segment finished: stop playback. Do NOT reset timelineTime or currentIndex; only reset when user presses play again.
          const slot = currentVisibleSlotRef.current;
          const ref = getMountedVideoRef(slot);
          if (ref) ref.pauseAsync().catch(() => {});
          soundRef.current?.pauseAsync().catch(() => {});
          setPlaybackEnded(true);
          setIsPlaying(false);
        }
        if (__DEV__) debugLog("advanceTo-ignored", { reason: "out-of-range", from: fromIndex, to: nextIndex });
        return;
      }
      let destinationIndex = nextIndex;
      if (!options?.force) {
        if (nextIndex > fromIndex + 1) {
          destinationIndex = fromIndex + 1;
          if (__DEV__) debugLog("advanceTo-ignored", { reason: "clamped-to-sequential", from: fromIndex, to: nextIndex, clampedTo: destinationIndex });
        } else if (nextIndex < fromIndex) {
          if (__DEV__) debugLog("advanceTo-ignored", { reason: "backward-without-force", from: fromIndex, to: nextIndex });
          return;
        }
      }
      const now = Date.now();
      if (!options?.force && now - lastAdvanceAtRef.current < ADVANCE_DEBOUNCE_MS) {
        if (__DEV__) debugLog("advanceTo-ignored", { reason: "debounce", from: fromIndex, to: destinationIndex });
        return;
      }
      lastAdvanceAtRef.current = now;
      if (__DEV__) debugLog("advanceTo-request", { from: fromIndex, to: destinationIndex, force: options?.force });

      const nextSeg = playList[destinationIndex];
      if (!nextSeg) return;
      const nextVisibleSlot = (visiblePlaybackSlotRef.current + 1) % 3;
      const fromSlot = currentVisibleSlotRef.current;
      const fromRef = getMountedVideoRef(fromSlot);
      const toRef = getMountedVideoRef(nextVisibleSlot);
      const seekSec = options?.seekToClipPosition ?? clampToFileDuration(nextSeg.uri, nextSeg.clipStart);
      const seekMs = seekSec * 1000;

      if (fromRef) {
        fromRef.pauseAsync().catch((e: unknown) => {
          console.warn("[Preview] advanceTo: pause current video failed", e);
        });
      } else if (__DEV__) {
        debugLog("slot-ref-null", { slot: fromSlot, action: "pause" });
      }
      debugLog("playback-slot-advance", {
        fromVisibleSlot: fromSlot,
        toVisibleSlot: nextVisibleSlot,
        destinationIndex,
      });

      if (toRef) {
        const token = ++slotSeekTokenRef.current[nextVisibleSlot];
        toRef
          .setPositionAsync(seekMs, { toleranceMillisBefore: 0, toleranceMillisAfter: 0 })
          .then(() => toRef.playAsync())
          .then(() => toRef.pauseAsync())
          .then(() => {
            if (token !== slotSeekTokenRef.current[nextVisibleSlot]) {
              if (__DEV__) debugLog("seek-token-stale", { slot: nextVisibleSlot, token });
              return;
            }
            visiblePlaybackSlotRef.current = nextVisibleSlot;
            setVisiblePlaybackSlot(nextVisibleSlot);
            currentIndexRef.current = destinationIndex;
            segmentBoundsRef.current = {
              startTime: nextSeg.startTime,
              endTime: nextSeg.endTime,
            };
            timelineTimeRef.current = nextSeg.startTime;
            setPlayheadTime(nextSeg.startTime);
            segmentStartTimeRef.current = Date.now() / 1000;
            setCurrentSegmentIndex(destinationIndex);
            if (__DEV__) debugLog("advanceTo-commit", { to: destinationIndex });
            debugLog("advanceTo-sync", {
              destinationIndex,
              startTime: nextSeg.startTime,
              endTime: nextSeg.endTime,
            });
            debugLog("segment-enter", {
              idx: destinationIndex,
              startTime: nextSeg.startTime,
              endTime: nextSeg.endTime,
            });

            const farSlot = (nextVisibleSlot + 2) % 3;
            const preloadIndex = destinationIndex + 2;
            const preloadSeg = playList[preloadIndex];
            if (preloadSeg?.uri) {
              const preloadRef = getMountedVideoRef(farSlot);
              if (preloadRef) {
                if (__DEV__) debugLog("playback-slot-preload", { farSlot, preloadIndex });
                const startMs = clampToFileDuration(preloadSeg.uri, preloadSeg.clipStart) * 1000;
                preloadRef
                  .setPositionAsync(startMs, { toleranceMillisBefore: 0, toleranceMillisAfter: 0 })
                  .then(() => preloadRef.playAsync())
                  .then(() => preloadRef.pauseAsync())
                  .catch(() => {});
              } else if (__DEV__) debugLog("slot-ref-null", { slot: farSlot, action: "preload" });
            }
          })
          .catch((e) => {
            if (__DEV__) console.warn("[Preview] advanceTo: toRef seek/warm failed", e);
            visiblePlaybackSlotRef.current = nextVisibleSlot;
            setVisiblePlaybackSlot(nextVisibleSlot);
            currentIndexRef.current = destinationIndex;
            segmentBoundsRef.current = { startTime: nextSeg.startTime, endTime: nextSeg.endTime };
            timelineTimeRef.current = nextSeg.startTime;
            setPlayheadTime(nextSeg.startTime);
            segmentStartTimeRef.current = Date.now() / 1000;
            setCurrentSegmentIndex(destinationIndex);
          });
      } else {
        if (__DEV__) debugLog("slot-ref-null", { slot: nextVisibleSlot, action: "advanceTo" });
        visiblePlaybackSlotRef.current = nextVisibleSlot;
        setVisiblePlaybackSlot(nextVisibleSlot);
        currentIndexRef.current = destinationIndex;
        segmentBoundsRef.current = { startTime: nextSeg.startTime, endTime: nextSeg.endTime };
        timelineTimeRef.current = nextSeg.startTime;
        setPlayheadTime(nextSeg.startTime);
        segmentStartTimeRef.current = Date.now() / 1000;
        setCurrentSegmentIndex(destinationIndex);
      }
    } catch (e) {
      console.error("[Preview] advanceTo crashed", e);
    } finally {
      advanceInFlightRef.current = false;
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

        const fileDur = fileDurationByUriRef.current[seg.uri];
        const effectiveClipEnd = fileDur != null && fileDur > 0
          ? Math.min(seg.clipEnd, fileDur - 0.05)
          : seg.clipEnd;
        const atClipEnd = position >= effectiveClipEnd - EPSILON;
        const atNaturalEnd = didJustFinish || (durationSec > 0 && position >= durationSec - EPSILON);
        const segmentDone =
          timelineTimeRef.current >= seg.endTime - EPSILON || atClipEnd || atNaturalEnd;

        if (segmentDone && !finishedSegmentsRef.current.has(idx)) {
          finishedSegmentsRef.current.add(idx);
          if (__DEV__) debugLog("segment-done", { idx });
          if (idx + 1 >= playList.length) {
            // Stop at end of timeline: pause video and audio, stop playback. Do NOT reset timelineTime or currentIndex; only reset when user presses play again.
            const slotRef = getMountedVideoRef(slot);
            if (slotRef) slotRef.pauseAsync().catch(() => {});
            else if (__DEV__) debugLog("slot-ref-null", { slot, action: "pause-at-end" });
            soundRef.current?.pauseAsync().catch(() => {});
            setPlaybackEnded(true);
            setIsPlaying(false);
            return;
          }
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
          const ref = getMountedVideoRef(slot);
          if (!ref) {
            if (__DEV__) debugLog("slot-ref-null", { slot, action: "loop-seek" });
            loopSeekInFlightRef.current[slot] = false;
            return;
          }
          const token = ++slotSeekTokenRef.current[slot];
          ref
            .setPositionAsync(seekSec * 1000)
            .catch(() => {})
            .finally(() => {
              if (token !== slotSeekTokenRef.current[slot]) {
                if (__DEV__) debugLog("seek-token-stale", { slot, token });
              }
              loopSeekInFlightRef.current[slot] = false;
            });
        }
      } catch (e) {
        console.error("[Preview] onPlaybackStatusUpdate crashed", e);
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

  function stopTimelineClock() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }

  function startTimelineClock() {
    if (rafRef.current !== null) return;
    lastFrameTimeRef.current = performance.now();

    function tick(now: number) {
      lastFrameTimeRef.current = now;

      if (isPlayingRef.current && !isScrubbingRef.current) {
        const idx = currentIndexRef.current;
        const list = playListRef.current;
        const seg = list[idx];
        if (!seg) {
          rafRef.current = requestAnimationFrame(tick);
          return;
        }
        const elapsed = Date.now() / 1000 - segmentStartTimeRef.current;
        const t = Math.min(seg.startTime + elapsed, seg.endTime);
        timelineTimeRef.current = t;
        setPlayheadTime(t);
        if (t >= seg.endTime - EPSILON) {
          advanceTo(idx + 1);
        }
        if (__DEV__ && Date.now() - playheadLogThrottleRef.current > 1000) {
          playheadLogThrottleRef.current = Date.now();
          debugLog("playhead", { playheadTime: t, segmentIndex: idx });
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
  }

  useEffect(() => {
    if (isPlaying) startTimelineClock();
    else stopTimelineClock();
    return () => stopTimelineClock();
  }, [isPlaying]);

  // When current segment has no clip, advance after segment duration (timeline/RAF is single source)
  useEffect(() => {
    if (!seg || seg.uri || isScrubbing || playList.length === 0 || !isPlaying) return;
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
        const activeRef = getMountedVideoRef(visibleSlotIndex);
        if (!activeRef) return;
        const startMs = startSecClamped * 1000;
        const logErr = (tag: string) => (e: unknown) => {
          console.warn(`[Preview] ${tag}`, e);
        };
        {
          const token = ++slotSeekTokenRef.current[visibleSlotIndex];
          if (activeRef.playFromPositionAsync) {
            activeRef.playFromPositionAsync(startMs).catch(logErr("playFromPositionAsync")).finally(() => {
              if (token !== slotSeekTokenRef.current[visibleSlotIndex] && __DEV__) debugLog("seek-token-stale", { slot: visibleSlotIndex, token });
            });
          } else {
            activeRef.setPositionAsync(startMs).catch(logErr("setPositionAsync"));
            activeRef.playAsync().catch(logErr("playAsync"));
          }
        }
      }
      const nextSlot = getPlaybackSlotForRelativeOffset(1, visiblePlaybackSlot);
      const nextNextSlot = getPlaybackSlotForRelativeOffset(2, visiblePlaybackSlot);
      const nextItem = playList[currentSegmentIndex + 1];
      const nextNextItem = playList[currentSegmentIndex + 2];
      if (nextItem?.uri) {
        const nextStart = clampToFileDuration(nextItem.uri, nextItem.clipStart);
        const nextRef = getMountedVideoRef(nextSlot);
        if (nextRef) {
          const token = ++slotSeekTokenRef.current[nextSlot];
          nextRef.setPositionAsync(nextStart * 1000).catch(() => {}).finally(() => {
            if (token !== slotSeekTokenRef.current[nextSlot] && __DEV__) debugLog("seek-token-stale", { slot: nextSlot, token });
          });
        }
      }
      if (nextNextItem?.uri) {
        const nextNextStart = clampToFileDuration(nextNextItem.uri, nextNextItem.clipStart);
        const nnRef = getMountedVideoRef(nextNextSlot);
        if (nnRef) {
          const token = ++slotSeekTokenRef.current[nextNextSlot];
          nnRef.setPositionAsync(nextNextStart * 1000).catch(() => {}).finally(() => {
            if (token !== slotSeekTokenRef.current[nextNextSlot] && __DEV__) debugLog("seek-token-stale", { slot: nextNextSlot, token });
          });
        }
      }
    } catch (e) {
      console.error("[Preview] segment sync effect crashed", e);
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

  function handleExport() {
    // Set ref synchronously so loading screen sees correct segments (state update is async).
    const toExport = segments.length > 0 ? segments.slice() : [];
    const totalDurationSec = toExport.length > 0 ? toExport[toExport.length - 1].endTime : 0;
    console.log("[TRACE] preview Export: segments as decided by user", {
      count: toExport.length,
      totalDurationSec,
      segments: toExport.map((s, i) => ({
        i,
        startTime: s.startTime,
        endTime: s.endTime,
        clipFilename: s.clipFilename,
        clipStart: s.clipStart,
        clipEnd: s.clipEnd,
      })),
    });
    exportSegmentsRef.current = toExport;
    setPendingExportSegments(toExport);
    router.replace("/loading?mode=export");
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.replace("/")}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Preview</Text>
          <Text style={styles.headerSubtitle}>Music + clips · Export to render</Text>
        </View>
        <TouchableOpacity
          style={styles.headerExportButton}
          onPress={handleExport}
        >
          <Ionicons name="arrow-forward" size={26} color="#fff" />
        </TouchableOpacity>
      </View>
      <View style={styles.previewArea}>
        <View style={styles.videoWrapper}>
          <View
            style={styles.videoContainer}
            onLayout={(e) => {
              const { layout } = e.nativeEvent;
              const isFirst = currentSegmentIndex === 0;
              const isLast = playList.length > 0 && currentSegmentIndex === playList.length - 1;
              if (__DEV__) {
                debugLog("preview:container-layout", {
                  currentSegmentIndex,
                  isFirst,
                  isLast,
                  width: layout.width,
                  height: layout.height,
                  x: layout.x,
                  y: layout.y,
                });
                perfLog("preview:container-layout", {
                  currentSegmentIndex,
                  isFirst,
                  isLast,
                  width: layout.width,
                  height: layout.height,
                });
              }
            }}
          >
            <View style={styles.videoClip}>
              {seg?.uri ? (
                <>
                  {Array.from({ length: 3 }, (_, slot) => {
                    const segmentIndex = getSegmentIndexForPlaybackSlot(slot);
                    const item = playList[segmentIndex];
                    const isVisible = slot === visiblePlaybackSlot;
                    const uri = item?.uri ?? playList[0]?.uri ?? "";
                    return (
                      <View key={slot} style={styles.slotLayer}>
                        {uri ? (
                          <Video
                            ref={videoRefs[slot]}
                            source={{ uri }}
                            style={[styles.video, isVisible ? styles.videoVisible : styles.videoHidden]}
                            resizeMode={ResizeMode.CONTAIN}
                            shouldPlay={isPlaying && isVisible && !isScrubbing}
                            isLooping={false}
                            volume={0}
                            muted
                            progressUpdateIntervalMillis={16}
                            onPlaybackStatusUpdate={onPlaybackStatusUpdate(slot)}
                          />
                        ) : null}
                      </View>
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
        </View>
        </View>
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
              if (info.segmentIndex !== currentIndexRef.current) {
                timelineTimeRef.current = t;
                setPlayheadTime(t);
                soundRef.current?.setPositionAsync(t * 1000).catch(() => {});
                advanceTo(info.segmentIndex, { force: true, seekToClipPosition: info.clipPosition });
              } else {
                setCurrentSegmentIndex(info.segmentIndex);
                pendingSeekRef.current = { segmentIndex: info.segmentIndex, clipPosition: info.clipPosition };
                soundRef.current?.setPositionAsync(t * 1000).catch(() => {});
              }
            }
          }}
          thumbnailUris={thumbnailUris}
          thumbnailFrameUris={thumbnailFrameUris}
          onScrubbingChange={(scrubbing) => {
            isScrubbingRef.current = scrubbing;
            setIsScrubbing(scrubbing);
            if (scrubbing) {
              const ref = getMountedVideoRef(visibleSlotIndex);
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
        <View style={styles.segmentInfoRow}>
          <Text style={styles.segmentInfoText}>
            Segment {currentSegmentIndex + 1} / {totalSegments} · {(totalDuration || (analyzeResult?.duration ?? 0)).toFixed(1)}s
          </Text>
        </View>
        <View style={styles.footerButtonsRow}>
          <TouchableOpacity
            style={styles.playPauseButton}
            onPress={() => {
              if (playbackEnded) {
                finishedSegmentsRef.current.clear();
                timelineTimeRef.current = 0;
                setPlayheadTime(0);
                setCurrentSegmentIndex(0);
                const first = playList[0];
                if (first) {
                  segmentBoundsRef.current = { startTime: first.startTime, endTime: first.endTime };
                  segmentStartTimeRef.current = Date.now() / 1000;
                }
                currentIndexRef.current = 0;
                const ref = getMountedVideoRef(visibleSlotIndex);
                if (ref) ref.setPositionAsync(0).catch(() => {});
                soundRef.current?.setPositionAsync(0).catch(() => {});
                setPlaybackEnded(false);
                setIsPlaying(true);
                soundRef.current?.playAsync().catch(() => {});
                return;
              }
              const next = !isPlaying;
              setIsPlaying(next);
              if (!next) {
                const ref = getMountedVideoRef(visibleSlotIndex);
                if (ref) ref.pauseAsync().catch(() => {});
                soundRef.current?.pauseAsync().catch(() => {});
              } else {
                soundRef.current?.playAsync().catch(() => {});
              }
            }}
          >
            <Ionicons name={isPlaying ? "pause" : "play"} size={28} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.resizeModeButton, resizeMode === "trim" && styles.resizeModeButtonActive]}
            onPress={() => setResizeMode((m) => (m === "moveCut" ? "trim" : "moveCut"))}
          >
            <Text style={[styles.resizeModeButtonText, resizeMode === "trim" && styles.resizeModeButtonTextActive]}>
              {resizeMode === "moveCut" ? "Slide mode" : "Trim mode"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.scissorsButton} onPress={addCutAtPlayhead} accessibilityLabel="Add cut at playhead">
            <Ionicons name="cut" size={22} color="#475569" />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.replaceButton, selectedSegmentIndex == null && styles.replaceButtonDisabled]}
            onPress={handleReplaceFromLibrary}
            disabled={selectedSegmentIndex == null}
            accessibilityLabel="Replace clip from library"
          >
            <Ionicons name="swap-horizontal" size={22} color={selectedSegmentIndex == null ? "#94a3b8" : "#475569"} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.deleteButton, selectedSegmentIndex == null && styles.deleteButtonDisabled]}
            onPress={deleteSelectedSegment}
            disabled={selectedSegmentIndex == null}
            accessibilityLabel="Delete selected clip"
          >
            <Ionicons name="trash-outline" size={22} color={selectedSegmentIndex == null ? "#94a3b8" : "#dc2626"} />
          </TouchableOpacity>
        </View>
      </View>

      {replaceSelectionPending != null && selectedSegmentIndex != null && segments[selectedSegmentIndex] != null && (
        <ClipSelectionModal
          visible
          videoUri={replaceSelectionPending.uri}
          segmentDurationSec={segments[selectedSegmentIndex].endTime - segments[selectedSegmentIndex].startTime}
          onConfirm={(clipStart, clipEnd) => {
            replaceSegmentWith(replaceSelectionPending, clipStart, clipEnd);
            setReplaceSelectionPending(null);
          }}
          onCancel={() => setReplaceSelectionPending(null)}
        />
      )}
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
  headerExportButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255, 255, 255, 0.25)",
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
  previewArea: {
    height: PREVIEW_AREA_HEIGHT,
    overflow: "hidden",
    backgroundColor: "transparent",
  },
  videoWrapper: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "transparent",
    paddingHorizontal: PREVIEW_MARGIN_H,
    paddingVertical: PREVIEW_MARGIN_V,
  },
  videoContainer: {
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    borderRadius: PREVIEW_CARD_BORDER_RADIUS,
    overflow: "hidden",
    backgroundColor: "transparent",
  },
  videoClip: {
    width: "100%",
    height: "100%",
    borderRadius: PREVIEW_CARD_BORDER_RADIUS,
    overflow: "hidden",
  },
  slotLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: "100%",
    height: "100%",
  },
  video: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: "100%",
    height: "100%",
  },
  videoVisible: { zIndex: 1 },
  videoHidden: { opacity: 0, position: "absolute" as const, zIndex: 0 },
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
  footer: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 28, backgroundColor: "#fff" },
  segmentInfoRow: { marginBottom: 14, alignItems: "center" },
  segmentInfoText: { fontSize: 13, color: "#64748b", fontWeight: "600" },
  footerButtonsRow: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  playPauseButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#6366f1",
    justifyContent: "center",
    alignItems: "center",
  },
  resizeModeButton: {
    height: 44,
    minWidth: 108,
    paddingHorizontal: 14,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(99, 102, 241, 0.15)",
    borderRadius: 10,
  },
  resizeModeButtonActive: { backgroundColor: "#6366f1" },
  resizeModeButtonText: { color: "#6366f1", fontSize: 13, fontWeight: "600" },
  resizeModeButtonTextActive: { color: "#fff" },
  scissorsButton: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: "#f1f5f9",
    justifyContent: "center",
    alignItems: "center",
  },
  replaceButton: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: "#f1f5f9",
    justifyContent: "center",
    alignItems: "center",
  },
  replaceButtonDisabled: { opacity: 0.6 },
  deleteButton: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: "#fef2f2",
    justifyContent: "center",
    alignItems: "center",
  },
  deleteButtonDisabled: { opacity: 0.6, backgroundColor: "#f1f5f9" },
});
