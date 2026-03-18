import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Image,
  Dimensions,
  PanResponder,
  ActivityIndicator,
} from "react-native";
import { Video, AVPlaybackStatus } from "expo-av";

let VideoThumbnails: typeof import("expo-video-thumbnails") | null = null;
try {
  VideoThumbnails = require("expo-video-thumbnails");
} catch {
  // optional
}

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const MODAL_STRIP_WIDTH = Math.min(SCREEN_WIDTH - 48, 320);
const STRIP_HEIGHT = 56;
const NUM_FRAMES = 12;
const MIN_DURATION = 0.05;

export interface ClipSelectionModalProps {
  visible: boolean;
  videoUri: string;
  /** Duration of the segment being replaced (selection length in seconds). */
  segmentDurationSec: number;
  onConfirm: (clipStart: number, clipEnd: number) => void;
  onCancel: () => void;
}

export default function ClipSelectionModal({
  visible,
  videoUri,
  segmentDurationSec,
  onConfirm,
  onCancel,
}: ClipSelectionModalProps) {
  const videoRef = useRef<Video>(null);
  const [videoDurationSec, setVideoDurationSec] = useState<number | null>(null);
  const [frameUris, setFrameUris] = useState<string[]>([]);
  const [selectionStart, setSelectionStart] = useState(0);
  const [loading, setLoading] = useState(true);
  const dragStartX = useRef(0);
  const selectionStartRef = useRef(0);

  useEffect(() => {
    selectionStartRef.current = selectionStart;
  }, [selectionStart]);

  const onPlaybackStatusUpdate = (status: AVPlaybackStatus) => {
    if (!status.isLoaded) return;
    const durationMillis = status.durationMillis ?? 0;
    const durationSec = durationMillis / 1000;
    if (durationSec > 0) {
      setVideoDurationSec((prev) => (prev == null ? durationSec : prev));
    }
  };

  useEffect(() => {
    if (!visible || !videoUri) {
      setVideoDurationSec(null);
      setFrameUris([]);
      setSelectionStart(0);
      setLoading(true);
      return;
    }
    setLoading(true);
    setVideoDurationSec(null);
  }, [visible, videoUri]);

  useEffect(() => {
    if (!visible || !videoUri || videoDurationSec == null || videoDurationSec <= 0) return;
    let cancelled = false;
    const times = Array.from({ length: NUM_FRAMES }, (_, i) =>
      i === NUM_FRAMES - 1 ? videoDurationSec - 0.01 : (i / (NUM_FRAMES - 1)) * videoDurationSec
    );
    Promise.all(
      times.map((t) =>
        VideoThumbnails
          ? VideoThumbnails.getThumbnailAsync(videoUri, { time: Math.round(t * 1000), quality: 0.6 })
          : Promise.resolve({ uri: null })
      )
    ).then((results) => {
      if (cancelled) return;
      setFrameUris(results.map((r) => (r && "uri" in r && r.uri ? r.uri : "")).filter(Boolean));
      const maxStart = Math.max(0, videoDurationSec - segmentDurationSec);
      setSelectionStart(0);
      selectionStartRef.current = 0;
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [visible, videoUri, videoDurationSec, segmentDurationSec]);

  const maxSelectionStart = videoDurationSec != null
    ? Math.max(0, videoDurationSec - segmentDurationSec - MIN_DURATION)
    : 0;
  const effectiveClipEnd = videoDurationSec != null ? Math.min(selectionStart + segmentDurationSec, videoDurationSec) : selectionStart + segmentDurationSec;

  const handleConfirm = () => {
    onConfirm(selectionStart, effectiveClipEnd);
  };

  const tooShort = videoDurationSec != null && videoDurationSec < segmentDurationSec - MIN_DURATION;

  if (!visible) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Video
        ref={videoRef}
        source={{ uri: videoUri }}
        style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}
        onPlaybackStatusUpdate={onPlaybackStatusUpdate}
      />
      <ClipSelectionModalInner
        videoDurationSec={videoDurationSec}
        segmentDurationSec={segmentDurationSec}
        frameUris={frameUris}
        loading={loading}
        selectionStart={selectionStart}
        setSelectionStart={setSelectionStart}
        selectionStartRef={selectionStartRef}
        maxSelectionStart={maxSelectionStart}
        effectiveClipEnd={effectiveClipEnd}
        onConfirm={handleConfirm}
        onCancel={onCancel}
        tooShort={tooShort}
      />
    </Modal>
  );
}

function ClipSelectionModalInner({
  videoDurationSec,
  segmentDurationSec,
  frameUris,
  loading,
  selectionStart,
  setSelectionStart,
  selectionStartRef,
  maxSelectionStart,
  effectiveClipEnd,
  onConfirm,
  onCancel,
  tooShort,
}: {
  videoDurationSec: number | null;
  segmentDurationSec: number;
  frameUris: string[];
  loading: boolean;
  selectionStart: number;
  setSelectionStart: (n: number) => void;
  selectionStartRef: React.MutableRefObject<number>;
  maxSelectionStart: number;
  effectiveClipEnd: number;
  onConfirm: () => void;
  onCancel: () => void;
  tooShort: boolean;
}) {
  const maxSelectionStartRef = useRef(maxSelectionStart);
  const videoDurationSecRef = useRef(videoDurationSec);
  maxSelectionStartRef.current = maxSelectionStart;
  videoDurationSecRef.current = videoDurationSec;
  const dragStartXRef = useRef(0);
  const selectionStartAtDragRef = useRef(0);
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (_, g) => {
        dragStartXRef.current = g.moveX;
        selectionStartAtDragRef.current = selectionStartRef.current;
      },
      onPanResponderMove: (_, g) => {
        const stripWidth = MODAL_STRIP_WIDTH;
        const dx = g.moveX - dragStartXRef.current;
        const dur = videoDurationSecRef.current ?? 0;
        const dxSec = dur > 0 ? (dx / stripWidth) * dur : 0;
        let next = selectionStartAtDragRef.current + dxSec;
        next = Math.max(0, Math.min(maxSelectionStartRef.current, next));
        setSelectionStart(next);
      },
    })
  ).current;

  const stripWidth = MODAL_STRIP_WIDTH;
  const selectionWidthRatio = videoDurationSec && videoDurationSec > 0
    ? segmentDurationSec / videoDurationSec
    : 0.2;
  const selectionWidth = stripWidth * Math.min(1, selectionWidthRatio);
  const leftRatio = videoDurationSec && videoDurationSec > 0 ? selectionStart / videoDurationSec : 0;
  const leftPx = stripWidth * Math.min(1, leftRatio);

  return (
    <View style={styles.backdrop}>
      <View style={styles.content}>
        <Text style={styles.title}>Choose clip range</Text>
        <Text style={styles.subtitle}>
          Drag the selection to pick which part of the video to use ({segmentDurationSec.toFixed(1)}s)
        </Text>

        {loading ? (
          <View style={[styles.strip, styles.stripLoading]}>
            <ActivityIndicator size="large" color="#6366f1" />
          </View>
        ) : (
          <>
            <View style={styles.strip}>
              {frameUris.map((uri, i) => (
                <Image
                  key={i}
                  source={{ uri }}
                  style={[styles.frame, { width: stripWidth / NUM_FRAMES }]}
                  resizeMode="cover"
                />
              ))}
              <View
                style={[
                  styles.selectionOverlay,
                  {
                    left: leftPx,
                    width: selectionWidth,
                  },
                ]}
                {...panResponder.panHandlers}
              >
                <View style={styles.selectionBorder} />
              </View>
            </View>
            <Text style={styles.timeLabel}>
              {selectionStart.toFixed(1)}s – {effectiveClipEnd.toFixed(1)}s
              {videoDurationSec != null ? ` of ${videoDurationSec.toFixed(1)}s` : ""}
            </Text>
            {tooShort && (
              <Text style={styles.warning}>
                Video is shorter than the segment; only the available range will be used.
              </Text>
            )}
          </>
        )}

        <View style={styles.buttons}>
          <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.confirmButton, loading && styles.confirmButtonDisabled]}
            onPress={onConfirm}
            disabled={loading}
          >
            <Text style={styles.confirmButtonText}>Use selection</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  content: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 20,
    width: "100%",
    maxWidth: 360,
  },
  title: { fontSize: 18, fontWeight: "700", color: "#1e293b", marginBottom: 4 },
  subtitle: { fontSize: 13, color: "#64748b", marginBottom: 16 },
  strip: {
    flexDirection: "row",
    height: STRIP_HEIGHT,
    width: MODAL_STRIP_WIDTH,
    alignSelf: "center",
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: "#000",
  },
  stripLoading: {
    justifyContent: "center",
    alignItems: "center",
  },
  frame: {
    height: STRIP_HEIGHT,
    flex: 0,
  },
  selectionOverlay: {
    position: "absolute",
    top: 0,
    bottom: 0,
    minWidth: 24,
    justifyContent: "center",
    alignItems: "center",
  },
  selectionBorder: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    borderWidth: 3,
    borderColor: "#6366f1",
    borderRadius: 4,
  },
  timeLabel: { fontSize: 12, color: "#64748b", marginTop: 8, textAlign: "center" },
  warning: { fontSize: 12, color: "#b45309", marginTop: 6, textAlign: "center" },
  buttons: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 12,
    marginTop: 20,
  },
  cancelButton: { paddingVertical: 10, paddingHorizontal: 16 },
  cancelButtonText: { fontSize: 15, fontWeight: "600", color: "#64748b" },
  confirmButton: {
    backgroundColor: "#6366f1",
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 10,
  },
  confirmButtonDisabled: { opacity: 0.6 },
  confirmButtonText: { fontSize: 15, fontWeight: "700", color: "#fff" },
});
