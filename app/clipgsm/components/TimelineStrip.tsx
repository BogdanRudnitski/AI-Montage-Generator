import React, { useRef, useMemo, useEffect } from "react";
import {
  View,
  Image,
  ScrollView,
  Text,
  StyleSheet,
  Dimensions,
  NativeSyntheticEvent,
  NativeTouchEvent,
} from "react-native";
import * as Haptics from "expo-haptics";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const STRIP_HEIGHT = 48;
const SCROLL_ZONE_HEIGHT = STRIP_HEIGHT * 2;

function debugLog(tag: string, data?: object) {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.log("[TimelineStrip]", tag, data ?? "");
  }
}
/** Logical gap between blocks (0 = clips touch so playhead never disappears in a gap). Use block separator border for visual separation. */
const BLOCK_GAP = 0;
const BLOCK_BORDER_RADIUS = 6;
/** Subtle 1px line between blocks for visual separation when BLOCK_GAP is 0. */
const BLOCK_SEPARATOR_COLOR = "rgba(0, 0, 0, 0.12)";
const SECONDS_PER_VIEWPORT_DEFAULT = 10;
const SECONDS_PER_VIEWPORT_MIN = 5;
const SECONDS_PER_VIEWPORT_MAX = 20;
const RESIZE_TOUCH_WIDTH = 28;
const RESIZE_BORDER_WIDTH = 8;
const MIN_CLIP_DURATION = 0.1;
const SCRUB_HIT_SLOP = 24;
const EPSILON = 0.01; // 10ms; float-safe boundary comparisons
const THUMB_WIDTH = 40;
/** Scroll zone inertia: min velocity (px/ms) to trigger coasting; below this release stops immediately. */
const SCROLL_INERTIA_VELOCITY_THRESHOLD = 0.1;
/** Per-frame velocity decay during inertia (0–1); higher = longer coast. */
const SCROLL_INERTIA_DECAY = 0.95;
const SCROLL_INERTIA_MIN_VELOCITY = 0.02;

export interface SegmentRecord {
  startTime: number;
  endTime: number;
  clipFilename: string;
  clipStart: number;
  clipEnd: number;
}

type GestureType = "idle" | "scrub" | "resizeLeft" | "resizeRight" | "tap";

export type ResizeResult = { segments: SegmentRecord[]; hitLimit: boolean } | null;

interface TimelineStripProps {
  segments: SegmentRecord[];
  totalDuration: number;
  segmentSourceDurations?: (number | null)[];
  playheadTime: number;
  onPlayheadChange: (t: number) => void;
  onSegmentsChange: (next: SegmentRecord[]) => void;
  selectedSegmentIndex: number | null;
  onSelectSegment: (index: number | null) => void;
  thumbnailUris: (string | null)[];
  thumbnailFrameUris?: (string | null)[][];
  onScrubbingChange?: (scrubbing: boolean) => void;
  onResizeStart?: (segmentIndex: number) => void;
  onResizeEnd?: () => void;
  timelineScrollX: number;
  timelineViewportWidth: number;
  onTimelineViewportLayout: (width: number) => void;
  timelineScrollRef: React.RefObject<ScrollView | null>;
  resizeMode?: "moveCut" | "trim";
  secondsPerViewport?: number;
  onSecondsPerViewportChange?: (value: number) => void;
}

export default function TimelineStrip({
  segments,
  totalDuration,
  segmentSourceDurations = [],
  playheadTime,
  onPlayheadChange,
  onSegmentsChange,
  selectedSegmentIndex,
  onSelectSegment,
  thumbnailUris,
  thumbnailFrameUris,
  onScrubbingChange,
  onResizeStart,
  onResizeEnd,
  timelineScrollX,
  timelineViewportWidth,
  onTimelineViewportLayout,
  timelineScrollRef,
  resizeMode = "moveCut",
  secondsPerViewport = SECONDS_PER_VIEWPORT_DEFAULT,
  onSecondsPerViewportChange,
}: TimelineStripProps) {
  const stripWidth =
    totalDuration > 0 ? (totalDuration / secondsPerViewport) * SCREEN_WIDTH : SCREEN_WIDTH;

  const stripLayout = useMemo(() => {
    const n = segments.length;
    if (n === 0 || totalDuration <= 0)
      return { leftEdges: [] as number[], blockWidths: [] as number[], contentWidth: 0 };
    const contentWidth = stripWidth - (n - 1) * BLOCK_GAP;
    const blockWidths = segments.map(
      (s) => ((s.endTime - s.startTime) / totalDuration) * contentWidth
    );
    const leftEdges: number[] = [];
    let x = 0;
    for (let i = 0; i < n; i++) {
      leftEdges.push(x);
      x += blockWidths[i] + BLOCK_GAP;
    }
    return { leftEdges, blockWidths, contentWidth };
  }, [segments, totalDuration, stripWidth]);

  const timeToX = (t: number): number => {
    if (!segments.length || stripLayout.leftEdges.length === 0 || totalDuration <= 0) return 0;
    if (t <= 0) return 0;
    const lastIdx = segments.length - 1;
    if (t >= segments[lastIdx].endTime - EPSILON) {
      return (
        stripLayout.leftEdges[lastIdx] + (stripLayout.blockWidths[lastIdx] ?? 0)
      );
    }
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (t >= seg.startTime - EPSILON && t < seg.endTime - EPSILON) {
        const left = stripLayout.leftEdges[i] ?? 0;
        const bw = stripLayout.blockWidths[i] ?? 0;
        const segDur = seg.endTime - seg.startTime;
        const frac = segDur > 0 ? (t - seg.startTime) / segDur : 0;
        return left + frac * bw;
      }
    }
    return 0;
  };

  const xToTime = (x: number): number => {
    if (!segments.length || stripLayout.blockWidths.length === 0 || totalDuration <= 0) return 0;
    if (x <= 0) return (x / stripWidth) * totalDuration;
    const { leftEdges, blockWidths } = stripLayout;
    const lastIdx = segments.length - 1;
    const lastRight = leftEdges[lastIdx] + (blockWidths[lastIdx] ?? 0);
    if (x >= lastRight) {
      const pxPerSec = stripWidth / totalDuration;
      return totalDuration + (x - lastRight) / pxPerSec;
    }
    for (let i = 0; i < leftEdges.length; i++) {
      const left = leftEdges[i];
      const bw = blockWidths[i] ?? 0;
      if (x >= left && x < left + bw) {
        const seg = segments[i];
        const frac = bw > 0 ? (x - left) / bw : 0;
        const segDur = seg.endTime - seg.startTime;
        return seg.startTime + frac * segDur;
      }
    }
    return segments[lastIdx]?.endTime ?? totalDuration;
  };

  const getSegmentIndexAtX = (x: number): number | null => {
    const { leftEdges, blockWidths } = stripLayout;
    for (let i = 0; i < leftEdges.length; i++) {
      const left = leftEdges[i];
      const bw = blockWidths[i] ?? 0;
      if (x >= left && x < left + bw) return i;
    }
    return null;
  };

  const gestureRef = useRef<{
    type: GestureType;
    segmentIndex?: number;
    startCutTime?: number;
    tapStartX?: number;
    startX?: number;
    startEndTime?: number;
    startStartTime?: number;
    startClipStart?: number;
    startClipEnd?: number;
    startSegments?: SegmentRecord[];
  }>({ type: "idle" });

  const isResizingRef = useRef(false);
  const lastHapticAtLimitRef = useRef(false);

  const viewportLeftRef = useRef(0);
  const viewportRef = useRef<View>(null);
  const segmentsRef = useRef(segments);
  const onSegmentsChangeRef = useRef(onSegmentsChange);
  const segmentSourceDurationsRef = useRef(segmentSourceDurations);
  const playheadTimeRef = useRef(playheadTime);
  segmentsRef.current = segments;
  onSegmentsChangeRef.current = onSegmentsChange;
  segmentSourceDurationsRef.current = segmentSourceDurations;
  playheadTimeRef.current = playheadTime;

  const getStripX = (e: { nativeEvent: { locationX: number; pageX: number } }) => {
    const pageX = e.nativeEvent.pageX;
    const locationX = e.nativeEvent.locationX;
    if (viewportLeftRef.current !== 0) {
      const xInStrip = pageX - viewportLeftRef.current + timelineScrollX - halfViewport;
      return xInStrip;
    }
    return locationX - halfViewport;
  };

  /** Clamp segment clip range to source duration: clipStart >= 0, clipEnd <= max, clipEnd - clipStart <= max. */
  const clampSegmentToSource = (
    clipStart: number,
    clipEnd: number,
    maxSourceDuration: number | null | undefined
  ): { clipStart: number; clipEnd: number } => {
    if (maxSourceDuration == null || maxSourceDuration <= 0)
      return { clipStart: Math.max(0, clipStart), clipEnd };
    let cs = Math.max(0, clipStart);
    let ce = Math.min(maxSourceDuration, clipEnd);
    if (ce - cs > maxSourceDuration) cs = Math.max(0, ce - maxSourceDuration);
    return { clipStart: cs, clipEnd: ce };
  };

  const chainSegmentBoundaries = (out: SegmentRecord[]): void => {
    if (out.length === 0) return;
    out[0].startTime = 0;
    for (let i = 1; i < out.length; i++) {
      const dur = out[i].endTime - out[i].startTime;
      out[i].startTime = out[i - 1].endTime;
      out[i].endTime = out[i].startTime + dur;
    }
  };

  const applyResizeRightLastSegment = (segmentIndex: number, newCutTime: number): ResizeResult => {
    const segs = segmentsRef.current;
    const srcDur = segmentSourceDurationsRef.current;
    if (segmentIndex < 0 || segmentIndex !== segs.length - 1) return null;
    const a = segs[segmentIndex];
    const TMin = a.startTime + MIN_CLIP_DURATION;
    const maxA = srcDur[segmentIndex];
    const maxTimelineEnd = maxA != null && maxA > 0
      ? Math.round((a.startTime + maxA) * 100) / 100
      : a.endTime + 60;
    let T = Math.round(Math.max(TMin, Math.min(maxTimelineEnd, newCutTime)) * 100) / 100;
    let hitLimit = false;
    if (T >= maxTimelineEnd) { T = maxTimelineEnd; hitLimit = true; }
    // Last segment: only vary clipEnd (right edge of source window); never change clipStart.
    const clipStartFixed = a.clipStart;
    let clipEndA = clipStartFixed + (T - a.startTime);
    if (maxA != null && maxA > 0 && clipEndA > maxA) {
      clipEndA = maxA;
      T = Math.round((a.startTime + (clipEndA - clipStartFixed)) * 100) / 100;
      T = Math.max(TMin, T);
      hitLimit = true;
    }
    if (clipEndA < clipStartFixed) clipEndA = clipStartFixed;
    const result = segs.map((seg, i) =>
      i === segmentIndex ? { ...seg, endTime: T, clipStart: clipStartFixed, clipEnd: clipEndA } : seg
    );
    chainSegmentBoundaries(result);
    return { segments: result, hitLimit };
  };

  const applyResizeRight = (segmentIndex: number, newCutTime: number): ResizeResult => {
    const segs = segmentsRef.current;
    const srcDur = segmentSourceDurationsRef.current;
    if (segmentIndex < 0 || segmentIndex >= segs.length) return null;
    if (segmentIndex === segs.length - 1) return applyResizeRightLastSegment(segmentIndex, newCutTime);
    const a = segs[segmentIndex];
    const b = segs[segmentIndex + 1];
    let T =
      Math.round(
        Math.max(a.startTime + MIN_CLIP_DURATION, Math.min(b.endTime - MIN_CLIP_DURATION, newCutTime)) * 100
      ) / 100;
    let hitLimit = false;
    const maxA = srcDur[segmentIndex];
    debugLog("resize-guard applyResizeRight", { segmentIndex, maxA, segsLength: segs.length });
    if (maxA != null && maxA > 0) {
      const maxTimelineEnd = Math.round((a.startTime + maxA) * 100) / 100;
      if (T > maxTimelineEnd) {
        T = maxTimelineEnd;
        hitLimit = true;
      }
    }
    const delta = T - a.endTime;
    const clipEndA = a.clipStart + (T - a.startTime);
    const { clipStart: csA, clipEnd: ceA } = clampSegmentToSource(a.clipStart, clipEndA, maxA);
    const result = segs.map((seg, i) => {
      if (i === segmentIndex) return { ...seg, endTime: T, clipStart: csA, clipEnd: ceA };
      if (i === segmentIndex + 1)
        return { ...seg, startTime: T, endTime: b.endTime + delta };
      if (i >= segmentIndex + 2)
        return { ...seg, startTime: seg.startTime + delta, endTime: seg.endTime + delta };
      return seg;
    });
    chainSegmentBoundaries(result);
    debugLog("resize-guard applyResizeRight result", { segmentIndex, hitLimit, clipEndA: result[segmentIndex]?.clipEnd });
    return { segments: result, hitLimit };
  };

  const applyResizeRightMoveCut = (segmentIndex: number, timeAtFinger: number): ResizeResult => {
    const segs = segmentsRef.current;
    const srcDur = segmentSourceDurationsRef.current;
    if (segmentIndex < 0 || segmentIndex >= segs.length - 1) return null;
    const a = segs[segmentIndex];
    const b = segs[segmentIndex + 1];
    let T =
      Math.round(
        Math.max(a.startTime + MIN_CLIP_DURATION, Math.min(b.endTime - MIN_CLIP_DURATION, timeAtFinger)) * 100
      ) / 100;
    let hitLimit = false;
    const maxA = srcDur[segmentIndex];
    const maxB = srcDur[segmentIndex + 1];
    debugLog("resize-guard applyResizeRightMoveCut", { segmentIndex, maxA, maxB });
    // Absolute deltas: clip boundaries move by the same amount as timeline boundaries.
    // Cap T so A's clip range doesn't exceed source duration.
    if (maxA != null && maxA > 0) {
      const maxT = Math.round((a.endTime + (maxA - a.clipEnd)) * 100) / 100;
      if (T > maxT) { T = Math.min(b.endTime - MIN_CLIP_DURATION, maxT); hitLimit = true; }
    }

    let clipEndA = a.clipEnd + (T - a.endTime);
    if (clipEndA < 0) clipEndA = 0;
    let clipStartB = b.clipStart + (T - b.startTime);
    if (clipStartB < 0) clipStartB = 0;

    const BSegDur = b.endTime - T;
    if (maxB != null && maxB > 0 && clipStartB + BSegDur > maxB) {
      clipStartB = Math.max(0, maxB - BSegDur);
      hitLimit = true;
    }
    const { clipStart: csA, clipEnd: ceA } = clampSegmentToSource(a.clipStart, clipEndA, maxA);
    const result = segs.map((seg, i) => {
      if (i === segmentIndex) return { ...seg, endTime: T, clipStart: csA, clipEnd: ceA };
      if (i === segmentIndex + 1) return { ...seg, startTime: T, clipStart: clipStartB };
      return seg;
    });
    chainSegmentBoundaries(result);
    debugLog("resize-guard applyResizeRightMoveCut result", { segmentIndex, hitLimit, clipEndA });
    return { segments: result, hitLimit };
  };

  const applyResizeLeftMoveCut = (segmentIndex: number, timeAtFinger: number): ResizeResult => {
    const segs = segmentsRef.current;
    const srcDur = segmentSourceDurationsRef.current;
    if (segmentIndex <= 0 || segmentIndex >= segs.length) return null;
    const prev = segs[segmentIndex - 1];
    const curr = segs[segmentIndex];
    let T =
      Math.round(
        Math.max(prev.startTime + MIN_CLIP_DURATION, Math.min(curr.endTime - MIN_CLIP_DURATION, timeAtFinger)) * 100
      ) / 100;
    let hitLimit = false;
    const maxPrev = srcDur[segmentIndex - 1];
    const maxCurr = srcDur[segmentIndex];
    debugLog("resize-guard applyResizeLeftMoveCut", { segmentIndex, maxPrev, maxCurr });
    // Absolute deltas: clip boundaries move by same amount as timeline boundaries.
    // Cap T so prev's clip range doesn't exceed source duration.
    if (maxPrev != null && maxPrev > 0) {
      const maxT = Math.round((curr.startTime + (maxPrev - prev.clipEnd)) * 100) / 100;
      if (T > Math.min(curr.endTime - MIN_CLIP_DURATION, maxT)) { T = Math.min(curr.endTime - MIN_CLIP_DURATION, maxT); hitLimit = true; }
    }
    if (maxPrev != null && maxPrev > 0 && (T - prev.startTime) > maxPrev) {
      T = Math.round((prev.startTime + maxPrev) * 100) / 100;
      T = Math.max(prev.startTime + MIN_CLIP_DURATION, Math.min(curr.endTime - MIN_CLIP_DURATION, T));
      hitLimit = true;
    }

    let clipEndPrev = prev.clipEnd + (T - curr.startTime);
    if (clipEndPrev < 0) clipEndPrev = 0;
    let clipStartCurr = curr.clipStart + (T - curr.startTime);
    if (clipStartCurr < 0) clipStartCurr = 0;
    let clipEndCurr = curr.clipEnd;
    if (maxCurr != null && maxCurr > 0 && clipEndCurr > maxCurr) {
      clipEndCurr = maxCurr;
      hitLimit = true;
    }
    let currEndTime = curr.endTime;
    const { clipStart: _csPrev, clipEnd: cePrev } = clampSegmentToSource(prev.clipStart, clipEndPrev, maxPrev);
    const { clipStart: csCurr, clipEnd: ceCurr } = clampSegmentToSource(clipStartCurr, clipEndCurr, maxCurr);
    const result = segs.map((seg, i) => {
      if (i === segmentIndex - 1) return { ...seg, endTime: T, clipEnd: cePrev };
      if (i === segmentIndex)
        return { ...seg, startTime: T, endTime: currEndTime, clipStart: csCurr, clipEnd: ceCurr };
      return seg;
    });
    chainSegmentBoundaries(result);
    debugLog("resize-guard applyResizeLeftMoveCut result", { segmentIndex, hitLimit });
    return { segments: result, hitLimit };
  };

  const applyResizeLeft = (
    segmentIndex: number,
    timeAtFinger: number,
    gestureStart: {
      startStartTime: number;
      startEndTime: number;
      startClipStart: number;
      startClipEnd: number;
      startSegments: SegmentRecord[];
    }
  ): ResizeResult => {
    const segs = gestureStart.startSegments;
    const srcDur = segmentSourceDurationsRef.current;
    if (segmentIndex < 0 || segmentIndex >= segs.length) return null;

    const clampedTime =
      Math.round(
        Math.max(
          gestureStart.startStartTime - 60,
          Math.min(gestureStart.startEndTime - MIN_CLIP_DURATION, timeAtFinger)
        ) * 100
      ) / 100;

    const delta = gestureStart.startStartTime - clampedTime;
    let newEndTime =
      Math.round((gestureStart.startEndTime + delta) * 100) / 100;
    const startTime = gestureStart.startStartTime;
    const maxCurr = srcDur[segmentIndex];
    if (maxCurr != null && maxCurr > 0) {
      const maxTimelineEnd = Math.round((startTime + maxCurr) * 100) / 100;
      if (newEndTime > maxTimelineEnd) { newEndTime = maxTimelineEnd; }
    }
    const segmentDuration = newEndTime - startTime;

    // Expand left: show more from start of source → clipEnd fixed, clipStart decreases as segment gets longer.
    let clipEnd = gestureStart.startClipEnd;
    let clipStart = clipEnd - segmentDuration;
    let hitLimit = false;
    debugLog("resize-guard applyResizeLeft", { segmentIndex, maxCurr });

    if (segmentIndex === 0) {
      // First segment: left edge fixed at timeline 0. Only vary clipStart (show more/less from start); never augment clipEnd.
      const maxClipEnd = maxCurr != null && maxCurr > 0 ? maxCurr : gestureStart.startClipEnd;
      clipEnd = Math.min(gestureStart.startClipEnd, maxClipEnd);
      clipStart = Math.max(0, clipEnd - segmentDuration);
      if (clipStart === 0 && clipEnd - 0 < segmentDuration) hitLimit = true;
      newEndTime = Math.round((startTime + (clipEnd - clipStart)) * 100) / 100;
    } else {
      if (clipStart < 0) {
        clipStart = 0;
        if (maxCurr != null && maxCurr > 0 && clipEnd > maxCurr) clipEnd = maxCurr;
        newEndTime = Math.round((startTime + (clipEnd - clipStart)) * 100) / 100;
        hitLimit = true;
      }
      if (maxCurr != null && maxCurr > 0 && clipEnd > maxCurr) {
        clipEnd = maxCurr;
        clipStart = Math.max(0, clipEnd - segmentDuration);
        hitLimit = true;
      }
      if (maxCurr != null && maxCurr > 0) {
        const maxSegDur = clipEnd - clipStart;
        if (newEndTime - startTime > maxSegDur) {
          newEndTime = Math.round((startTime + maxSegDur) * 100) / 100;
          clipStart = clipEnd - maxSegDur;
          hitLimit = true;
        }
      }
    }
    const { clipStart: finalClipStart, clipEnd: finalClipEnd } =
      segmentIndex === 0
        ? { clipStart: clipStart, clipEnd: clipEnd }
        : clampSegmentToSource(clipStart, clipEnd, maxCurr);

    const shift = newEndTime - gestureStart.startEndTime;
    const result = segs.map((seg, i) => {
      if (i < segmentIndex) return seg;

      if (i === segmentIndex) {
        return {
          ...seg,
          startTime: gestureStart.startStartTime,
          endTime: newEndTime,
          clipStart: finalClipStart,
          clipEnd: finalClipEnd,
        };
      }

      return {
        ...seg,
        startTime: seg.startTime + shift,
        endTime: seg.endTime + shift,
      };
    });
    chainSegmentBoundaries(result);
    debugLog("resize-guard applyResizeLeft result", { segmentIndex, hitLimit, clipEnd: result[segmentIndex]?.clipEnd });
    return { segments: result, hitLimit };
  };

  const handleTouchStart = (e: NativeSyntheticEvent<NativeTouchEvent>) => {
    viewportRef.current?.measureInWindow((x) => {
      viewportLeftRef.current = x;
    });
    const x = getStripX(e);
    if (stripWidth <= 0 || totalDuration <= 0) return;

    const playheadX = timeToX(playheadTimeRef.current);
    const sel = selectedSegmentIndex;

    const leftEdgeSel = sel != null ? stripLayout.leftEdges[sel] ?? 0 : null;
    const rightEdgeSel =
      sel != null
        ? (stripLayout.leftEdges[sel] ?? 0) + (stripLayout.blockWidths[sel] ?? 0)
        : null;
    debugLog("touchStart", {
      x,
      stripWidth,
      playheadX,
      selectedIndex: sel,
      leftZone: leftEdgeSel != null ? [leftEdgeSel, leftEdgeSel + RESIZE_TOUCH_WIDTH] : null,
      rightZone: rightEdgeSel != null ? [rightEdgeSel - RESIZE_TOUCH_WIDTH, rightEdgeSel] : null,
    });

    if (sel != null) {
      const leftEdge = stripLayout.leftEdges[sel] ?? 0;
      if (x >= leftEdge && x < leftEdge + RESIZE_TOUCH_WIDTH) {
        const seg = segments[sel];
        debugLog("gesture", {
          type: "resizeLeft",
          segmentIndex: sel,
          segment: seg
            ? {
                startTime: Math.round(seg.startTime * 100) / 100,
                endTime: Math.round(seg.endTime * 100) / 100,
              }
            : null,
        });
        gestureRef.current = {
          type: "resizeLeft",
          segmentIndex: sel,
          startCutTime: seg.startTime,
          startX: x,
          startEndTime: seg.endTime,
          startStartTime: seg.startTime,
          startClipStart: seg.clipStart,
          startClipEnd: seg.clipEnd ?? seg.clipStart,
          startSegments: segmentsRef.current.map((s) => ({ ...s })),
        };
        try {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        } catch (_) {}
        isResizingRef.current = true;
        onResizeStart?.(sel);
        onScrubbingChange?.(true);
        return;
      }
    }
    if (sel != null) {
      const rightEdge = (stripLayout.leftEdges[sel] ?? 0) + (stripLayout.blockWidths[sel] ?? 0);
      const isLast = sel === segments.length - 1;
      if (x > rightEdge - RESIZE_TOUCH_WIDTH && (isLast ? x <= rightEdge + RESIZE_TOUCH_WIDTH : x <= rightEdge)) {
        debugLog("gesture", { type: "resizeRight", segmentIndex: sel });
        gestureRef.current = {
          type: "resizeRight",
          segmentIndex: sel,
          startCutTime: segments[sel].endTime,
        };
        try {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        } catch (_) {}
        isResizingRef.current = true;
        onResizeStart?.(sel);
        onScrubbingChange?.(true);
        return;
      }
    }
    if (sel === null && Math.abs(x - playheadX) <= SCRUB_HIT_SLOP) {
      debugLog("gesture", { type: "scrub" });
      gestureRef.current = { type: "scrub" };
      onScrubbingChange?.(true);
      return;
    }
    debugLog("gesture", { type: "tap", tapStartX: x });
    gestureRef.current = { type: "tap", tapStartX: x };
  };

  const handleTouchMove = (e: NativeSyntheticEvent<NativeTouchEvent>) => {
    const rawX = getStripX(e);
    const g = gestureRef.current;
    const isResize = g.type === "resizeLeft" || g.type === "resizeRight";
    const x = isResize ? rawX : Math.max(0, Math.min(stripWidth, rawX));
    if (!isResize && (rawX < -20 || rawX > stripWidth + 20)) {
      return;
    }

    if (g.type === "scrub") {
      const t = xToTime(x);
      onPlayheadChange(t);
      return;
    }
    if (g.type === "resizeLeft" && g.segmentIndex != null) {
      const segs = segmentsRef.current;
      const currentSeg = segs[g.segmentIndex];
      const timeAtFinger = xToTime(x);
      const useMoveCut = resizeMode === "moveCut" && g.segmentIndex > 0;
      const result: ResizeResult =
        useMoveCut
          ? applyResizeLeftMoveCut(g.segmentIndex, timeAtFinger)
          : g.startStartTime != null &&
              g.startEndTime != null &&
              g.startClipStart != null &&
              g.startClipEnd != null &&
              g.startSegments != null
            ? applyResizeLeft(g.segmentIndex, timeAtFinger, {
                startStartTime: g.startStartTime,
                startEndTime: g.startEndTime,
                startClipStart: g.startClipStart,
                startClipEnd: g.startClipEnd,
                startSegments: g.startSegments,
              })
            : null;
      const next = result?.segments ?? null;
      const nextSeg = next?.[g.segmentIndex];
      debugLog("resizeMove", {
        type: "resizeLeft",
        segmentIndex: g.segmentIndex,
        x: Math.round(x * 100) / 100,
        timeAtFinger: Math.round(timeAtFinger * 100) / 100,
        current: currentSeg
          ? {
              startTime: Math.round(currentSeg.startTime * 100) / 100,
              endTime: Math.round(currentSeg.endTime * 100) / 100,
            }
          : null,
        next: nextSeg
          ? {
              startTime: Math.round(nextSeg.startTime * 100) / 100,
              endTime: Math.round(nextSeg.endTime * 100) / 100,
            }
          : null,
        willCallCallback: !!next,
      });
      if (!result || !next) {
        if (!result) {
          debugLog("resizeMove", { type: "resizeLeft", segmentIndex: g.segmentIndex, skipped: "applyResizeLeft returned null" });
        }
      } else {
        const cb = onSegmentsChangeRef.current;
        if (cb) {
          cb(next);
        }
        if (result.hitLimit) {
          if (!lastHapticAtLimitRef.current) {
            lastHapticAtLimitRef.current = true;
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          }
        } else {
          lastHapticAtLimitRef.current = false;
        }
        const seg = next[g.segmentIndex];
        if (!seg) return;
        const newStart = seg.startTime;
        onPlayheadChange(newStart + 0.001);
      }
      return;
    }
    if (g.type === "resizeRight" && g.segmentIndex != null) {
      const segs = segmentsRef.current;
      const currentSeg = segs[g.segmentIndex];
      const newT = xToTime(x);
      const isLastSegment = g.segmentIndex === segs.length - 1;
      const result: ResizeResult = isLastSegment
        ? applyResizeRight(g.segmentIndex, newT)
        : resizeMode === "moveCut"
          ? applyResizeRightMoveCut(g.segmentIndex, newT)
          : applyResizeRight(g.segmentIndex, newT);
      const next = result?.segments ?? null;
      const nextSeg = next?.[g.segmentIndex];
      debugLog("resizeMove", {
        type: "resizeRight",
        segmentIndex: g.segmentIndex,
        x: Math.round(x * 100) / 100,
        timeAtFinger: Math.round(newT * 100) / 100,
        current: currentSeg
          ? {
              startTime: Math.round(currentSeg.startTime * 100) / 100,
              endTime: Math.round(currentSeg.endTime * 100) / 100,
            }
          : null,
        next: nextSeg
          ? {
              startTime: Math.round(nextSeg.startTime * 100) / 100,
              endTime: Math.round(nextSeg.endTime * 100) / 100,
            }
          : null,
        willCallCallback: !!next,
      });
      if (!result || !next) {
        if (!result) {
          debugLog("resizeMove", { type: "resizeRight", segmentIndex: g.segmentIndex, skipped: "applyResizeRight returned null" });
        }
      } else {
        const cb = onSegmentsChangeRef.current;
        if (cb) {
          cb(next);
        } else {
          debugLog("error", { msg: "onSegmentsChange ref is null" });
        }
        if (result.hitLimit) {
          if (!lastHapticAtLimitRef.current) {
            lastHapticAtLimitRef.current = true;
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          }
        } else {
          lastHapticAtLimitRef.current = false;
        }
        const nextSeg = next[g.segmentIndex];
        if (!nextSeg) return;
        const segDur = nextSeg.endTime - nextSeg.startTime;
        const insideEpsilon = Math.min(0.05, Math.max(0.02, segDur * 0.1));
        const cutTime = Math.max(nextSeg.endTime - insideEpsilon, nextSeg.startTime + 0.01);
        onPlayheadChange(cutTime);
      }
      return;
    }
  };

  const handleTouchEnd = () => {
    const g = gestureRef.current;
    if (g.type === "scrub") {
      onScrubbingChange?.(false);
    }
    if (g.type === "resizeLeft" || g.type === "resizeRight") {
      isResizingRef.current = false;
      lastHapticAtLimitRef.current = false;
      onScrubbingChange?.(false);
      onResizeEnd?.();
    }
    if (g.type === "tap" && g.tapStartX != null) {
      const idx = getSegmentIndexAtX(g.tapStartX);
      if (idx != null) {
        if (idx === selectedSegmentIndex) {
          onSelectSegment(null);
        } else {
          onSelectSegment(idx);
        }
      }
    }
    gestureRef.current = { type: "idle" };
  };

  const handleTouchCancel = () => {
    if (gestureRef.current.type === "resizeLeft" || gestureRef.current.type === "resizeRight") {
      isResizingRef.current = false;
      onResizeEnd?.();
    }
    onScrubbingChange?.(false);
    gestureRef.current = { type: "idle" };
  };

  const halfViewport = timelineViewportWidth / 2;

  const scrollZoneGestureRef = useRef<"scrub" | "zoom" | null>(null);
  const scrollZoneStartPageX = useRef(0);
  const scrollZoneStartPlayheadTime = useRef(0);
  const zoomInitialDistanceRef = useRef(0);
  const zoomInitialSecondsPerViewportRef = useRef(secondsPerViewport);
  const scrollZoneLastMoveTime = useRef<number | null>(null);
  const scrollZoneLastTime = useRef(0);
  const scrollZoneVelocity = useRef(0);
  const inertiaRafRef = useRef<number | null>(null);
  const inertiaPlayheadRef = useRef(0);

  const pxToTime = (px: number) => (stripWidth > 0 ? (px / stripWidth) * totalDuration : 0);

  const handleScrollZoneTouchStart = (e: NativeSyntheticEvent<NativeTouchEvent>) => {
    const touches = e.nativeEvent.touches;
    if (inertiaRafRef.current != null) {
      cancelAnimationFrame(inertiaRafRef.current);
      inertiaRafRef.current = null;
    }
    if (touches.length >= 2) {
      scrollZoneGestureRef.current = "zoom";
      const d = Math.hypot(
        touches[1].pageX - touches[0].pageX,
        touches[1].pageY - touches[0].pageY
      );
      zoomInitialDistanceRef.current = d;
      zoomInitialSecondsPerViewportRef.current = secondsPerViewport;
    } else if (touches.length === 1) {
      scrollZoneGestureRef.current = "scrub";
      scrollZoneStartPageX.current = touches[0].pageX;
      scrollZoneStartPlayheadTime.current = playheadTimeRef.current;
      scrollZoneLastMoveTime.current = null;
      scrollZoneLastTime.current = playheadTimeRef.current;
      scrollZoneVelocity.current = 0;
      onScrubbingChange?.(true);
    }
  };

  const handleScrollZoneTouchMove = (e: NativeSyntheticEvent<NativeTouchEvent>) => {
    const touches = e.nativeEvent.touches;
    if (scrollZoneGestureRef.current === "zoom" && touches.length >= 2 && onSecondsPerViewportChange) {
      const d = Math.hypot(
        touches[1].pageX - touches[0].pageX,
        touches[1].pageY - touches[0].pageY
      );
      const delta = (d - zoomInitialDistanceRef.current) * 0.015;
      const newSPV = Math.max(
        SECONDS_PER_VIEWPORT_MIN,
        Math.min(SECONDS_PER_VIEWPORT_MAX, zoomInitialSecondsPerViewportRef.current - delta)
      );
      onSecondsPerViewportChange(newSPV);
    } else if (scrollZoneGestureRef.current === "scrub" && touches.length === 1) {
      const dx = touches[0].pageX - scrollZoneStartPageX.current;
      const dt = pxToTime(-dx);
      const newTime = Math.max(0, Math.min(totalDuration, scrollZoneStartPlayheadTime.current + dt));
      const now = Date.now();
      if (scrollZoneLastMoveTime.current != null) {
        const elapsed = now - scrollZoneLastMoveTime.current;
        if (elapsed > 0) {
          scrollZoneVelocity.current = (newTime - scrollZoneLastTime.current) / elapsed;
        }
      }
      scrollZoneLastTime.current = newTime;
      scrollZoneLastMoveTime.current = now;
      onPlayheadChange(newTime);
    }
  };

  const handleScrollZoneTouchEnd = () => {
    const wasScrub = scrollZoneGestureRef.current === "scrub";
    const velocity = scrollZoneVelocity.current;
    scrollZoneGestureRef.current = null;
    scrollZoneLastMoveTime.current = null;

    if (wasScrub) {
      const velThreshold = totalDuration > 0 ? 0.0001 * totalDuration : 0.001;
      if (Math.abs(velocity) >= velThreshold) {
        if (inertiaRafRef.current != null) cancelAnimationFrame(inertiaRafRef.current);
        let v = velocity;
        inertiaPlayheadRef.current = scrollZoneLastTime.current;
        let lastTime = Date.now();

        const tick = () => {
          const now = Date.now();
          const dt = Math.min(now - lastTime, 50);
          lastTime = now;
          let t = inertiaPlayheadRef.current + v * dt;
          v *= SCROLL_INERTIA_DECAY;
          if (t < 0) { t = 0; v = 0; }
          else if (t > totalDuration) { t = totalDuration; v = 0; }
          inertiaPlayheadRef.current = t;
          onPlayheadChange(t);
          const minV = totalDuration > 0 ? 0.00002 * totalDuration : 0.0001;
          if (Math.abs(v) >= minV) {
            inertiaRafRef.current = requestAnimationFrame(tick);
          } else {
            inertiaRafRef.current = null;
            onScrubbingChange?.(false);
          }
        };
        inertiaRafRef.current = requestAnimationFrame(tick);
      } else {
        onScrubbingChange?.(false);
      }
    }
  };

  const handleScrollZoneTouchCancel = () => {
    scrollZoneGestureRef.current = null;
    scrollZoneLastMoveTime.current = null;
    onScrubbingChange?.(false);
    if (inertiaRafRef.current != null) {
      cancelAnimationFrame(inertiaRafRef.current);
      inertiaRafRef.current = null;
    }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  useEffect(() => () => {
    if (inertiaRafRef.current != null) cancelAnimationFrame(inertiaRafRef.current);
  }, []);

  if (segments.length === 0 || totalDuration <= 0) return null;

  const paddedStripWidth = stripWidth + timelineViewportWidth;

  return (
    <View style={styles.stripContainer}>
      <View style={styles.stripTimeRow}>
        <Text style={styles.sliderTime}>{formatTime(playheadTime)}</Text>
        <Text style={styles.sliderTime}>{formatTime(totalDuration)}</Text>
      </View>
      <View
        ref={viewportRef}
        style={styles.timelineViewport}
        onLayout={(e) => {
          onTimelineViewportLayout(e.nativeEvent.layout.width);
          viewportRef.current?.measureInWindow((x) => {
            viewportLeftRef.current = x;
          });
        }}
      >
        <ScrollView
          ref={timelineScrollRef}
          horizontal
          scrollEnabled={false}
          showsHorizontalScrollIndicator={false}
          style={[styles.timelineScrollViewInner, { height: STRIP_HEIGHT + 4 }]}
          contentContainerStyle={styles.timelineScrollContent}
          scrollEventThrottle={32}
        >
          <View
            style={[styles.frameStripWrap, { width: paddedStripWidth }]}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchCancel}
          >
            <View style={[styles.frameStripRow, { gap: BLOCK_GAP, marginLeft: halfViewport }]}>
              {segments.map((seg, i) => {
                const isSelected = selectedSegmentIndex === i;
                const blockWidth = stripLayout.blockWidths[i] ?? 0;
                const isLast = i === segments.length - 1;
                const g = gestureRef.current;
                const isResizingThis =
                  (g.type === "resizeLeft" || g.type === "resizeRight") && g.segmentIndex === i;
                const durationSec = seg.endTime - seg.startTime;
                const durationLabel = isResizingThis ? `${durationSec.toFixed(1)}s` : null;
                return (
                  <View
                    key={i}
                    style={[
                      isSelected ? styles.selectedBlockWrapper : undefined,
                      {
                        width: blockWidth,
                        borderRadius: BLOCK_BORDER_RADIUS,
                        borderWidth: isSelected ? 1 : 0,
                        borderLeftWidth: isSelected ? RESIZE_BORDER_WIDTH : 0,
                        borderRightWidth: isSelected ? RESIZE_BORDER_WIDTH : isLast ? 0 : 1,
                        borderColor: "#6366f1",
                        position: "relative",
                        ...(isSelected ? {} : { borderRightColor: BLOCK_SEPARATOR_COLOR }),
                      },
                    ]}
                  >
                    <View
                      style={[
                        styles.thumbFrame,
                        {
                          flex: 1,
                          borderRadius: isSelected ? 0 : BLOCK_BORDER_RADIUS,
                          flexDirection: "row",
                        },
                      ]}
                      pointerEvents="none"
                    >
                      {(() => {
                        const frames = thumbnailFrameUris?.[i];
                        if (frames?.length) {
                          return frames.map((frameUri, j) => (
                            <View
                              key={j}
                              style={[
                                styles.thumbFrameSlice,
                                { width: THUMB_WIDTH },
                              ]}
                            >
                              {frameUri ? (
                                <Image
                                  source={{ uri: frameUri }}
                                  style={[
                                    styles.thumbFrameImage,
                                    { borderRadius: 0 },
                                  ]}
                                  resizeMode="cover"
                                />
                              ) : (
                                <View style={[styles.thumbPlaceholder, styles.thumbFrameSlicePlaceholder]} />
                              )}
                            </View>
                          ));
                        }
                        if (thumbnailUris[i]) {
                          return (
                            <Image
                              source={{ uri: thumbnailUris[i]! }}
                              style={[
                                styles.thumbImage,
                                {
                                  width: THUMB_WIDTH,
                                  borderRadius: isSelected ? 0 : BLOCK_BORDER_RADIUS,
                                },
                              ]}
                              resizeMode="cover"
                            />
                          );
                        }
                        return <View style={styles.thumbPlaceholder} />;
                      })()}
                    </View>
                    {durationLabel != null && (
                      <View
                        style={[
                          styles.durationLabelOverlay,
                          g.type === "resizeRight"
                            ? { right: 0, left: undefined, alignItems: "flex-end" }
                            : { left: 0, right: undefined, alignItems: "flex-start" },
                        ]}
                        pointerEvents="none"
                      >
                        <Text style={styles.durationLabelText}>{durationLabel}</Text>
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          </View>
        </ScrollView>
        {/* Fixed centered playhead line */}
        <View style={[styles.centeredPlayhead, { left: halfViewport - 1.5 }]} pointerEvents="none" />
        <View
          style={styles.scrollZone}
          onTouchStart={handleScrollZoneTouchStart}
          onTouchMove={handleScrollZoneTouchMove}
          onTouchEnd={handleScrollZoneTouchEnd}
          onTouchCancel={handleScrollZoneTouchCancel}
        />
      </View>
    </View>
  );
}

const PLAYHEAD_WIDTH = 3;

const styles = StyleSheet.create({
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
  sliderTime: { fontSize: 12, color: "#64748b", minWidth: 36, textAlign: "center" as const },
  timelineViewport: {
    position: "relative",
  },
  timelineScrollViewInner: { height: STRIP_HEIGHT + 4 },
  timelineScrollContent: { flexGrow: 0 },
  scrollZone: {
    height: SCROLL_ZONE_HEIGHT,
    backgroundColor: "rgba(100, 116, 139, 0.06)",
    marginTop: 2,
  },
  centeredPlayhead: {
    position: "absolute",
    top: -6,
    bottom: 0,
    width: PLAYHEAD_WIDTH,
    backgroundColor: "#fff",
    zIndex: 10,
    borderRadius: PLAYHEAD_WIDTH / 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 2,
    elevation: 4,
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
    top: 0,
  },
  thumbFrame: {
    overflow: "hidden",
    backgroundColor: "#1e293b",
    minWidth: 4,
  },
  thumbFrameSlice: {
    minWidth: 2,
    overflow: "hidden",
    position: "relative",
  },
  thumbImage: { width: "100%", height: "100%" },
  thumbFrameImage: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    width: undefined,
    height: undefined,
  },
  thumbPlaceholder: {
    flex: 1,
    backgroundColor: "#334155",
    minHeight: STRIP_HEIGHT,
  },
  thumbFrameSlicePlaceholder: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  selectedBlockWrapper: {
    position: "relative",
    overflow: "hidden",
  },
  durationLabelOverlay: {
    position: "absolute",
    top: 0,
    bottom: 0,
    justifyContent: "center",
    paddingHorizontal: 4,
    minWidth: 28,
  },
  durationLabelText: {
    fontSize: 10,
    color: "#fff",
    textShadowColor: "rgba(0,0,0,0.8)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
});
