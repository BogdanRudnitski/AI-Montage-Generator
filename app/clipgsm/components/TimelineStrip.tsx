import React, { useRef, useMemo, useState, useEffect } from "react";
import {
  View,
  Image,
  ScrollView,
  Text,
  StyleSheet,
  Dimensions,
  NativeSyntheticEvent,
  NativeTouchEvent,
  Animated,
} from "react-native";
import * as Haptics from "expo-haptics";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const STRIP_HEIGHT = 48;
const SCROLL_ZONE_HEIGHT = STRIP_HEIGHT * 2;
const SCRUB_ZONE_HEIGHT = Math.round(SCROLL_ZONE_HEIGHT / 4);
const TIMELINE_BLOCK_HEIGHT = SCRUB_ZONE_HEIGHT + STRIP_HEIGHT + SCROLL_ZONE_HEIGHT;

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
const RESIZE_EDGE_WIDTH = 28;
const SCRUB_HIT_SLOP = 24;
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

interface TimelineStripProps {
  segments: SegmentRecord[];
  totalDuration: number;
  playheadTime: number;
  onPlayheadChange: (t: number) => void;
  onSegmentsChange: (next: SegmentRecord[]) => void;
  selectedSegmentIndex: number | null;
  onSelectSegment: (index: number | null) => void;
  thumbnailUris: (string | null)[];
  /** Optional: multiple frame URIs per segment for TikTok-style strip; each segment can have [uri1, uri2, ...]. */
  thumbnailFrameUris?: (string | null)[][];
  onScrubbingChange?: (scrubbing: boolean) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  timelineScrollX: number;
  onTimelineScrollChange: (x: number) => void;
  timelineViewportWidth: number;
  onTimelineViewportLayout: (width: number) => void;
  timelineScrollRef: React.RefObject<ScrollView | null>;
  /** "moveCut" = only move the cut between two clips (default). "trim" = change duration and shift following segments. */
  resizeMode?: "moveCut" | "trim";
  /** Seconds of timeline shown across the viewport width; default 10. Two-finger zoom in scroll zone changes this. */
  secondsPerViewport?: number;
  /** Called when user zooms with two fingers in the scroll zone. */
  onSecondsPerViewportChange?: (value: number) => void;
}

export default function TimelineStrip({
  segments,
  totalDuration,
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
  onTimelineScrollChange,
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
    if (t >= segments[lastIdx].endTime) {
      return (
        stripLayout.leftEdges[lastIdx] + (stripLayout.blockWidths[lastIdx] ?? 0)
      );
    }
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (t >= seg.startTime && t < seg.endTime) {
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
    const { leftEdges, blockWidths } = stripLayout;
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
    return segments[segments.length - 1]?.endTime ?? totalDuration;
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

  const viewportLeftRef = useRef(0);
  const viewportRef = useRef<View>(null);
  const segmentsRef = useRef(segments);
  const onSegmentsChangeRef = useRef(onSegmentsChange);
  segmentsRef.current = segments;
  onSegmentsChangeRef.current = onSegmentsChange;

  const getStripX = (e: { nativeEvent: { locationX: number; pageX: number } }) => {
    const pageX = e.nativeEvent.pageX;
    const locationX = e.nativeEvent.locationX;
    if (viewportLeftRef.current !== 0) {
      const xInStrip = pageX - viewportLeftRef.current + timelineScrollX;
      if (xInStrip >= 0 && xInStrip <= stripWidth * 1.1) {
        return Math.max(0, Math.min(stripWidth, xInStrip));
      }
    }
    return Math.max(0, Math.min(stripWidth, locationX));
  };

  const applyResizeRight = (segmentIndex: number, newCutTime: number): SegmentRecord[] | null => {
    const segs = segmentsRef.current;
    if (segmentIndex < 0 || segmentIndex >= segs.length - 1) return null;
    const a = segs[segmentIndex];
    const b = segs[segmentIndex + 1];
    const clipLenB = Math.max(0.05, (b.clipEnd ?? b.clipStart) - b.clipStart);
    const T =
      Math.round(
        Math.max(a.startTime + 0.05, Math.min(b.endTime - 0.05, newCutTime)) * 100
      ) / 100;
    const delta = T - a.endTime;
    const clipEndA = a.clipStart + (T - a.startTime);
    const clipStartB =
      (b.clipEnd ?? b.clipStart + clipLenB) - (b.endTime - T);
    return segs.map((seg, i) => {
      if (i === segmentIndex) return { ...seg, endTime: T, clipEnd: clipEndA };
      if (i === segmentIndex + 1)
        return { ...seg, startTime: T, endTime: b.endTime + delta, clipStart: clipStartB };
      if (i >= segmentIndex + 2)
        return { ...seg, startTime: seg.startTime + delta, endTime: seg.endTime + delta };
      return seg;
    });
  };

  const applyResizeRightMoveCut = (segmentIndex: number, timeAtFinger: number): SegmentRecord[] | null => {
    const segs = segmentsRef.current;
    if (segmentIndex < 0 || segmentIndex >= segs.length - 1) return null;
    const a = segs[segmentIndex];
    const b = segs[segmentIndex + 1];
    const T =
      Math.round(
        Math.max(a.startTime + 0.05, Math.min(b.endTime - 0.05, timeAtFinger)) * 100
      ) / 100;
    const segDurA = a.endTime - a.startTime;
    const clipDurA = Math.max(0.05, (a.clipEnd ?? a.clipStart) - a.clipStart);
    const clipEndA = segDurA > 0
      ? a.clipStart + ((T - a.startTime) / segDurA) * clipDurA
      : a.clipStart;
    const segDurB = b.endTime - b.startTime;
    const clipDurB = Math.max(0.05, (b.clipEnd ?? b.clipStart) - b.clipStart);
    const clipStartB =
      segDurB > 0
        ? b.clipStart + ((T - b.startTime) / segDurB) * clipDurB
        : b.clipStart;
    return segs.map((seg, i) => {
      if (i === segmentIndex) return { ...seg, endTime: T, clipEnd: clipEndA };
      if (i === segmentIndex + 1) return { ...seg, startTime: T, clipStart: clipStartB };
      return seg;
    });
  };

  const applyResizeLeftMoveCut = (segmentIndex: number, timeAtFinger: number): SegmentRecord[] | null => {
    const segs = segmentsRef.current;
    if (segmentIndex <= 0 || segmentIndex >= segs.length) return null;
    const prev = segs[segmentIndex - 1];
    const curr = segs[segmentIndex];
    const T =
      Math.round(
        Math.max(prev.startTime + 0.05, Math.min(curr.endTime - 0.05, timeAtFinger)) * 100
      ) / 100;
    const prevSegDur = curr.startTime - prev.startTime;
    const prevClipDur = Math.max(0.05, (prev.clipEnd ?? prev.clipStart) - prev.clipStart);
    const clipEndPrev =
      prevSegDur > 0
        ? prev.clipStart + ((T - prev.startTime) / prevSegDur) * prevClipDur
        : prev.clipStart;
    const currSegDur = curr.endTime - curr.startTime;
    const currClipDur = Math.max(0.05, (curr.clipEnd ?? curr.clipStart) - curr.clipStart);
    const newCurrSegDur = curr.endTime - T;
    const clipStartCurr =
      currSegDur > 0
        ? curr.clipStart + ((T - curr.startTime) / currSegDur) * currClipDur
        : curr.clipStart;
    const clipEndCurr = currSegDur > 0
      ? clipStartCurr + (newCurrSegDur / currSegDur) * currClipDur
      : clipStartCurr;
    return segs.map((seg, i) => {
      if (i === segmentIndex - 1) return { ...seg, endTime: T, clipEnd: clipEndPrev };
      if (i === segmentIndex)
        return { ...seg, startTime: T, clipStart: clipStartCurr, clipEnd: clipEndCurr };
      return seg;
    });
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
  ): SegmentRecord[] | null => {
    const segs = gestureStart.startSegments;
    if (segmentIndex < 0 || segmentIndex >= segs.length) return null;

    const clampedTime =
      Math.round(
        Math.max(
          gestureStart.startStartTime - 60,
          Math.min(gestureStart.startEndTime - 0.05, timeAtFinger)
        ) * 100
      ) / 100;

    const delta = gestureStart.startStartTime - clampedTime;

    const newEndTime =
      Math.round((gestureStart.startEndTime + delta) * 100) / 100;

    const clipStart = gestureStart.startClipStart + delta;
    const clipEnd = gestureStart.startClipEnd + delta;

    return segs.map((seg, i) => {
      if (i < segmentIndex) return seg;

      if (i === segmentIndex) {
        return {
          ...seg,
          startTime: gestureStart.startStartTime,
          endTime: newEndTime,
          clipStart,
          clipEnd,
        };
      }

      return {
        ...seg,
        startTime: seg.startTime + delta,
        endTime: seg.endTime + delta,
      };
    });
  };

  const handleTouchStart = (e: NativeSyntheticEvent<NativeTouchEvent>) => {
    viewportRef.current?.measureInWindow((x) => {
      viewportLeftRef.current = x;
    });
    const x = getStripX(e);
    if (stripWidth <= 0 || totalDuration <= 0) return;

    const playheadX = timeToX(playheadTime);
    const sel = selectedSegmentIndex;

    const leftEdgeSel = sel != null && sel > 0 ? stripLayout.leftEdges[sel] ?? 0 : null;
    const rightEdgeSel =
      sel != null && sel < segments.length - 1
        ? (stripLayout.leftEdges[sel] ?? 0) + (stripLayout.blockWidths[sel] ?? 0)
        : null;
    debugLog("touchStart", {
      x,
      stripWidth,
      playheadX,
      selectedIndex: sel,
      leftZone: leftEdgeSel != null ? [leftEdgeSel, leftEdgeSel + RESIZE_EDGE_WIDTH] : null,
      rightZone: rightEdgeSel != null ? [rightEdgeSel - RESIZE_EDGE_WIDTH, rightEdgeSel] : null,
    });

    if (sel != null && sel > 0) {
      const leftEdge = stripLayout.leftEdges[sel] ?? 0;
      if (x >= leftEdge && x < leftEdge + RESIZE_EDGE_WIDTH) {
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
        onResizeStart?.();
        onScrubbingChange?.(true);
        return;
      }
    }
    if (sel != null && sel < segments.length - 1) {
      const rightEdge = (stripLayout.leftEdges[sel] ?? 0) + (stripLayout.blockWidths[sel] ?? 0);
      if (x > rightEdge - RESIZE_EDGE_WIDTH && x <= rightEdge) {
        debugLog("gesture", { type: "resizeRight", segmentIndex: sel });
        gestureRef.current = {
          type: "resizeRight",
          segmentIndex: sel,
          startCutTime: segments[sel].endTime,
        };
        try {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        } catch (_) {}
        onResizeStart?.();
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
    const x = getStripX(e);
    if (x < 0 || x > stripWidth) {
      return;
    }
    const g = gestureRef.current;

    if (g.type === "scrub") {
      const t = xToTime(x);
      onPlayheadChange(t);
      return;
    }
    if (g.type === "resizeLeft" && g.segmentIndex != null) {
      const segs = segmentsRef.current;
      const currentSeg = segs[g.segmentIndex];
      const timeAtFinger = xToTime(x);
      const next =
        resizeMode === "moveCut"
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
      if (!next) {
        debugLog("resizeMove", { type: "resizeLeft", segmentIndex: g.segmentIndex, skipped: "applyResizeLeft returned null" });
      } else {
        const cb = onSegmentsChangeRef.current;
        if (cb) {
          cb(next);
        }
        const seg = next[g.segmentIndex];
        const newStart = seg?.startTime ?? 0;
        const newEnd = seg?.endTime ?? 0;
        if (playheadTime < newStart) {
          onPlayheadChange(newStart);
        } else if (playheadTime > newEnd) {
          onPlayheadChange(newEnd);
        }
      }
      return;
    }
    if (g.type === "resizeRight" && g.segmentIndex != null) {
      const segs = segmentsRef.current;
      const currentSeg = segs[g.segmentIndex];
      const newT = xToTime(x);
      const next =
        resizeMode === "moveCut"
          ? applyResizeRightMoveCut(g.segmentIndex, newT)
          : applyResizeRight(g.segmentIndex, newT);
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
      if (!next) {
        debugLog("resizeMove", { type: "resizeRight", segmentIndex: g.segmentIndex, skipped: "applyResizeRight returned null" });
      } else {
        const cb = onSegmentsChangeRef.current;
        if (cb) {
          cb(next);
        } else {
          debugLog("error", { msg: "onSegmentsChange ref is null" });
        }
        const cutTime = currentSeg?.endTime ?? 0;
        const delta = newT - cutTime;
        if (playheadTime >= cutTime) {
          onPlayheadChange(playheadTime + delta);
        }
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
      onResizeEnd?.();
    }
    onScrubbingChange?.(false);
    gestureRef.current = { type: "idle" };
  };

  const handleScrollZoneTouchStart = (e: NativeSyntheticEvent<NativeTouchEvent>) => {
    const touches = e.nativeEvent.touches;
    if (touches.length >= 2) {
      scrollZoneGestureRef.current = "zoom";
      const d = Math.hypot(
        touches[1].pageX - touches[0].pageX,
        touches[1].pageY - touches[0].pageY
      );
      zoomInitialDistanceRef.current = d;
      zoomInitialSecondsPerViewportRef.current = secondsPerViewport;
    } else if (touches.length === 1) {
      scrollZoneGestureRef.current = "scroll";
      scrollTrackStartScrollX.current = timelineScrollX;
      scrollTrackStartPageX.current = touches[0].pageX;
      scrollZoneLastMoveTime.current = null;
      if (inertiaRafRef.current != null) {
        cancelAnimationFrame(inertiaRafRef.current);
        inertiaRafRef.current = null;
      }
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
    } else if (scrollZoneGestureRef.current === "scroll" && touches.length === 1) {
      const dx = touches[0].pageX - scrollTrackStartPageX.current;
      const nextX = Math.max(
        0,
        Math.min(maxTimelineScroll, scrollTrackStartScrollX.current - dx)
      );
      const now = Date.now();
      if (scrollZoneLastMoveTime.current != null) {
        const dt = now - scrollZoneLastMoveTime.current;
        if (dt > 0) {
          const prevX = scrollZoneLastScrollX.current;
          scrollZoneVelocity.current = (nextX - prevX) / dt;
        }
      }
      scrollZoneLastScrollX.current = nextX;
      scrollZoneLastMoveTime.current = now;
      onTimelineScrollChange(nextX);
      timelineScrollRef.current?.scrollTo({ x: nextX, animated: false });
      showScrollTrack();
    }
  };

  const maxTimelineScroll = Math.max(0, stripWidth - timelineViewportWidth);
  const scrollTrackStartScrollX = useRef(0);
  const scrollTrackStartPageX = useRef(0);
  const scrollZoneGestureRef = useRef<"scroll" | "zoom" | null>(null);
  const zoomInitialDistanceRef = useRef(0);
  const zoomInitialSecondsPerViewportRef = useRef(secondsPerViewport);
  const scrollZoneLastMoveTime = useRef<number | null>(null);
  const scrollZoneLastScrollX = useRef(0);
  const scrollZoneVelocity = useRef(0);
  const inertiaScrollXRef = useRef(0);
  const inertiaRafRef = useRef<number | null>(null);

  const handleScrollZoneTouchEnd = () => {
    const wasScroll = scrollZoneGestureRef.current === "scroll";
    const velocity = scrollZoneVelocity.current;
    scrollZoneGestureRef.current = null;
    scrollZoneLastMoveTime.current = null;

    if (wasScroll && maxTimelineScroll > 0 && Math.abs(velocity) >= SCROLL_INERTIA_VELOCITY_THRESHOLD) {
      if (inertiaRafRef.current != null) cancelAnimationFrame(inertiaRafRef.current);
      let v = velocity;
      inertiaScrollXRef.current = timelineScrollX;
      const max = maxTimelineScroll;
      let lastTime = Date.now();

      const tick = () => {
        const now = Date.now();
        const dt = Math.min(now - lastTime, 50);
        lastTime = now;
        let x = inertiaScrollXRef.current;
        x += v * dt;
        v *= SCROLL_INERTIA_DECAY;
        if (x < 0) {
          x = 0;
          v = 0;
        } else if (x > max) {
          x = max;
          v = 0;
        }
        inertiaScrollXRef.current = x;
        onTimelineScrollChange(x);
        timelineScrollRef.current?.scrollTo({ x, animated: false });
        showScrollTrack();
        if (Math.abs(v) >= SCROLL_INERTIA_MIN_VELOCITY) {
          inertiaRafRef.current = requestAnimationFrame(tick);
        } else {
          inertiaRafRef.current = null;
        }
      };
      inertiaRafRef.current = requestAnimationFrame(tick);
    }
  };

  const handleScrollZoneTouchCancel = () => {
    scrollZoneGestureRef.current = null;
    scrollZoneLastMoveTime.current = null;
    if (inertiaRafRef.current != null) {
      cancelAnimationFrame(inertiaRafRef.current);
      inertiaRafRef.current = null;
    }
  };

  const scrollTrackOpacity = useRef(new Animated.Value(0)).current;
  const scrollTrackHideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showScrollTrack = () => {
    if (scrollTrackHideTimeoutRef.current) {
      clearTimeout(scrollTrackHideTimeoutRef.current);
      scrollTrackHideTimeoutRef.current = null;
    }
    Animated.timing(scrollTrackOpacity, {
      toValue: 1,
      duration: 40,
      useNativeDriver: true,
    }).start();
    scrollTrackHideTimeoutRef.current = setTimeout(() => {
      scrollTrackHideTimeoutRef.current = null;
      Animated.timing(scrollTrackOpacity, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }, 1000);
  };

  const handleScrollTrackStart = (e: NativeSyntheticEvent<NativeTouchEvent>) => {
    scrollTrackStartScrollX.current = timelineScrollX;
    scrollTrackStartPageX.current = e.nativeEvent.pageX;
    showScrollTrack();
  };
  const handleScrollTrackMove = (e: NativeSyntheticEvent<NativeTouchEvent>) => {
    const dx = e.nativeEvent.pageX - scrollTrackStartPageX.current;
    const nextX = Math.max(
      0,
      Math.min(maxTimelineScroll, scrollTrackStartScrollX.current - dx)
    );
    onTimelineScrollChange(nextX);
    timelineScrollRef.current?.scrollTo({ x: nextX, animated: false });
    showScrollTrack();
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const [showScrubStamp, setShowScrubStamp] = useState(false);
  const scrubStampOpacity = useRef(new Animated.Value(0)).current;
  const scrubStampHideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrubZoneActiveRef = useRef(false);

  const getScrubZoneStripX = (pageX: number) => {
    const x = pageX - viewportLeftRef.current + timelineScrollX;
    return Math.max(0, Math.min(stripWidth, x));
  };

  const handleScrubZoneTouchStart = () => {
    viewportRef.current?.measureInWindow((x) => {
      viewportLeftRef.current = x;
    });
    if (stripWidth <= 0 || totalDuration <= 0) return;
    if (scrubStampHideTimeoutRef.current) {
      clearTimeout(scrubStampHideTimeoutRef.current);
      scrubStampHideTimeoutRef.current = null;
    }
    scrubZoneActiveRef.current = true;
    onScrubbingChange?.(true);
    setShowScrubStamp(true);
    Animated.timing(scrubStampOpacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
  };

  const handleScrubZoneTouchMove = (e: NativeSyntheticEvent<NativeTouchEvent>) => {
    if (!scrubZoneActiveRef.current || stripWidth <= 0 || totalDuration <= 0) return;
    const touches = e.nativeEvent.touches;
    if (touches.length === 0) return;
    const stripX = getScrubZoneStripX(touches[0].pageX);
    const t = xToTime(stripX);
    onPlayheadChange(t);
  };

  const handleScrubZoneTouchEnd = () => {
    if (!scrubZoneActiveRef.current) return;
    scrubZoneActiveRef.current = false;
    onScrubbingChange?.(false);
    if (scrubStampHideTimeoutRef.current) clearTimeout(scrubStampHideTimeoutRef.current);
    scrubStampHideTimeoutRef.current = setTimeout(() => {
      scrubStampHideTimeoutRef.current = null;
      Animated.timing(scrubStampOpacity, { toValue: 0, duration: 200, useNativeDriver: true }).start(
        () => setShowScrubStamp(false)
      );
    }, 1000);
  };

  const handleScrubZoneTouchCancel = () => {
    scrubZoneActiveRef.current = false;
    onScrubbingChange?.(false);
    if (scrubStampHideTimeoutRef.current) clearTimeout(scrubStampHideTimeoutRef.current);
    scrubStampHideTimeoutRef.current = setTimeout(() => {
      scrubStampHideTimeoutRef.current = null;
      Animated.timing(scrubStampOpacity, { toValue: 0, duration: 200, useNativeDriver: true }).start(
        () => setShowScrubStamp(false)
      );
    }, 1000);
  };

  useEffect(() => () => {
    if (scrubStampHideTimeoutRef.current) clearTimeout(scrubStampHideTimeoutRef.current);
    if (scrollTrackHideTimeoutRef.current) clearTimeout(scrollTrackHideTimeoutRef.current);
    if (inertiaRafRef.current != null) cancelAnimationFrame(inertiaRafRef.current);
  }, []);

  if (segments.length === 0 || totalDuration <= 0) return null;

  return (
    <View style={styles.stripContainer}>
      <View style={styles.stripTimeRow}>
        <Text style={styles.sliderTime}>{formatTime(playheadTime)}</Text>
        <Text style={styles.sliderTime}>{formatTime(totalDuration)}</Text>
      </View>
      <View
        ref={viewportRef}
        style={[styles.timelineScrollView, { minHeight: TIMELINE_BLOCK_HEIGHT }]}
        onLayout={(e) => {
          onTimelineViewportLayout(e.nativeEvent.layout.width);
          viewportRef.current?.measureInWindow((x) => {
            viewportLeftRef.current = x;
          });
        }}
      >
        <View
          style={styles.scrubZone}
          onTouchStart={handleScrubZoneTouchStart}
          onTouchMove={handleScrubZoneTouchMove}
          onTouchEnd={handleScrubZoneTouchEnd}
          onTouchCancel={handleScrubZoneTouchCancel}
        >
          {showScrubStamp && (
            <Animated.View
              pointerEvents="none"
              style={[
                styles.scrubStamp,
                {
                  left: stripWidth > 0 ? timeToX(playheadTime) - timelineScrollX : 0,
                  opacity: scrubStampOpacity,
                },
              ]}
            >
              <Text style={styles.scrubStampText} numberOfLines={1}>
                {formatTime(playheadTime)}
              </Text>
            </Animated.View>
          )}
        </View>
        <ScrollView
          ref={timelineScrollRef}
          horizontal
          scrollEnabled={false}
          showsHorizontalScrollIndicator={false}
          style={[styles.timelineScrollViewInner, { height: STRIP_HEIGHT + 4 }]}
          contentContainerStyle={styles.timelineScrollContent}
          onScroll={(e) => onTimelineScrollChange(e.nativeEvent.contentOffset.x)}
          scrollEventThrottle={32}
        >
          <View
            style={[styles.frameStripWrap, { width: stripWidth }]}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchCancel}
          >
            <View style={[styles.frameStripRow, { gap: BLOCK_GAP }]}>
              {segments.map((seg, i) => {
                const isSelected = selectedSegmentIndex === i;
                const blockWidth = stripLayout.blockWidths[i] ?? 0;
                const isLast = i === segments.length - 1;
                return (
                  <View
                    key={i}
                    style={[
                      isSelected ? styles.selectedBlockWrapper : undefined,
                      {
                        width: blockWidth,
                        borderRadius: BLOCK_BORDER_RADIUS,
                        borderWidth: isSelected ? 1 : 0,
                        borderLeftWidth: isSelected ? RESIZE_EDGE_WIDTH : 0,
                        borderRightWidth: isSelected ? RESIZE_EDGE_WIDTH : isLast ? 0 : 1,
                        borderColor: "#6366f1",
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
                  </View>
                );
              })}
            </View>
            <View
              style={[
                styles.stripPlayhead,
                { left: stripWidth > 0 ? timeToX(playheadTime) - 2 : 0 },
              ]}
              pointerEvents="none"
            />
          </View>
        </ScrollView>
        <View
          style={styles.scrollZone}
          onTouchStart={handleScrollZoneTouchStart}
          onTouchMove={handleScrollZoneTouchMove}
          onTouchEnd={handleScrollZoneTouchEnd}
          onTouchCancel={handleScrollZoneTouchCancel}
        />
        {maxTimelineScroll > 0 && (
          <Animated.View
            style={[styles.scrollTrack, { opacity: scrollTrackOpacity }]}
            onTouchStart={handleScrollTrackStart}
            onTouchMove={handleScrollTrackMove}
          >
            <View
              style={[
                styles.scrollTrackThumb,
                (() => {
                  const trackInner = Math.max(0, timelineViewportWidth - 16);
                  const thumbW = Math.max(
                    40,
                    (timelineViewportWidth / stripWidth) * trackInner
                  );
                  const thumbLeft =
                    trackInner > thumbW
                      ? 8 + (timelineScrollX / maxTimelineScroll) * (trackInner - thumbW)
                      : 8;
                  return { width: thumbW, left: thumbLeft };
                })(),
              ]}
            />
          </Animated.View>
        )}
      </View>
    </View>
  );
}

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
  timelineScrollView: { marginBottom: 4 },
  scrubZone: {
    height: SCRUB_ZONE_HEIGHT,
    backgroundColor: "rgba(100, 116, 139, 0.08)",
    marginBottom: 4,
    position: "relative",
  },
  scrubStamp: {
    position: "absolute",
    bottom: 2,
    transform: [{ translateX: "-50%" }],
    backgroundColor: "rgba(99, 102, 241, 0.95)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  scrubStampText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#fff",
  },
  timelineScrollViewInner: { height: STRIP_HEIGHT + 4 },
  scrollZone: {
    height: SCROLL_ZONE_HEIGHT,
    backgroundColor: "rgba(100, 116, 139, 0.12)",
    marginTop: 4,
  },
  scrollTrack: {
    height: 14,
    marginTop: 4,
    paddingHorizontal: 8,
    justifyContent: "center",
    backgroundColor: "rgba(100, 116, 139, 0.15)",
    borderRadius: 7,
  },
  scrollTrackThumb: {
    position: "absolute",
    height: 10,
    top: 2,
    borderRadius: 5,
    backgroundColor: "#6366f1",
  },
  timelineScrollContent: { flexGrow: 0 },
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
  stripPlayhead: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 4,
    backgroundColor: "#6366f1",
    borderRadius: 2,
    zIndex: 1,
  },
});
