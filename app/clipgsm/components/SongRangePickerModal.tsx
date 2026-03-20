import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  PanResponder,
  LayoutChangeEvent,
  ActivityIndicator,
} from "react-native";
import { Audio, AVPlaybackStatus } from "expo-av";
import { Ionicons } from "@expo/vector-icons";
import { SERVER_URL } from "../config";

const NUM_BARS = 72;

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type Props = {
  visible: boolean;
  onClose: () => void;
  songName: string;
  songUri: string;
  /** Analysis / video window length (e.g. 15–60). */
  windowDurationSec: number;
  initialStartSec: number;
  onConfirm: (startSec: number) => void;
};

export function SongRangePickerModal({
  visible,
  onClose,
  songName,
  songUri,
  windowDurationSec,
  initialStartSec,
  onConfirm,
}: Props) {
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const [loading, setLoading] = useState(true);
  const [songDurationSec, setSongDurationSec] = useState(1);
  const [startSec, setStartSec] = useState(initialStartSec);
  const [trackWidth, setTrackWidth] = useState(280);
  const [waveBars, setWaveBars] = useState<number[]>(() => Array.from({ length: NUM_BARS }, () => 0.35));

  const startSecRef = useRef(initialStartSec);
  const panOriginStartRef = useRef(0);
  const isDraggingRef = useRef(false);
  const soundRef = useRef<Audio.Sound | null>(null);

  useEffect(() => {
    startSecRef.current = startSec;
  }, [startSec]);

  const clampStart = useCallback(
    (v: number) => {
      const w = Math.max(0.1, windowDurationSec);
      const d = Math.max(0.1, songDurationSec);
      const hi = Math.max(0, d - w);
      return Math.min(hi, Math.max(0, v));
    },
    [songDurationSec, windowDurationSec]
  );

  useEffect(() => {
    if (visible) {
      const s = clampStart(initialStartSec);
      startSecRef.current = s;
      setStartSec(s);
    }
  }, [visible, initialStartSec, clampStart]);

  useEffect(() => {
    if (!visible) return;
    setStartSec((s) => {
      const next = clampStart(s);
      startSecRef.current = next;
      return next;
    });
  }, [songDurationSec, windowDurationSec, visible, clampStart]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!visible || !songUri) {
        return;
      }
      setLoading(true);
      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
          shouldDuckAndroid: true,
          playThroughEarpieceAndroid: false,
          staysActiveInBackground: false,
        });
        const { sound: sn } = await Audio.Sound.createAsync(
          { uri: songUri },
          { shouldPlay: false },
          (status: AVPlaybackStatus) => {
            if (!status.isLoaded) return;
            const durMs = status.durationMillis ?? 0;
            if (durMs > 0) {
              setSongDurationSec(Math.max(0.1, durMs / 1000));
            }
            if (isDraggingRef.current) return;
            const pos = (status.positionMillis ?? 0) / 1000;
            const winEnd = startSecRef.current + windowDurationSec;
            if (status.isPlaying && pos >= winEnd - 0.04) {
              sn.setPositionAsync(startSecRef.current * 1000).catch(() => {});
            }
          }
        );
        if (cancelled) {
          await sn.unloadAsync();
          return;
        }
        await sn.setProgressUpdateIntervalAsync(50);
        soundRef.current = sn;
        setSound(sn);
        await sn.setPositionAsync(startSecRef.current * 1000);
        await sn.playAsync();
      } catch {
        setSound(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, songUri, windowDurationSec]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!visible) return;
      try {
        const query = `bars=${NUM_BARS}&song_filename=${encodeURIComponent(songName || "")}`;
        const res = await fetch(`${SERVER_URL}/api/song-waveform?${query}`);
        const data = await res.json();
        if (!mounted) return;
        const bars = Array.isArray(data?.bars) ? data.bars : [];
        if (bars.length > 0) {
          setWaveBars(
            bars.map((v: number) =>
              Math.max(0.08, Math.min(1, Number.isFinite(v) ? Number(v) : 0.08))
            )
          );
        }
      } catch {
        // Keep fallback bars if waveform request fails.
      }
    })();
    return () => {
      mounted = false;
    };
  }, [visible, songName]);

  useEffect(() => {
    if (!visible && sound) {
      sound.stopAsync().catch(() => {});
      sound.unloadAsync().catch(() => {});
      soundRef.current = null;
      setSound(null);
    }
  }, [visible, sound]);

  const selectionWidthPx = useMemo(() => {
    const d = Math.max(0.01, songDurationSec);
    const ratio = Math.min(1, Math.max(0.01, windowDurationSec) / d);
    return Math.max(24, ratio * trackWidth);
  }, [songDurationSec, windowDurationSec, trackWidth]);

  const selectionLeftPx = useMemo(() => {
    const d = Math.max(0.01, songDurationSec);
    return (startSec / d) * trackWidth;
  }, [startSec, songDurationSec, trackWidth]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          isDraggingRef.current = true;
          panOriginStartRef.current = startSecRef.current;
          const s = soundRef.current;
          if (s) {
            s.pauseAsync().catch(() => {});
          }
        },
        onPanResponderMove: (_, g) => {
          const d = Math.max(0.01, songDurationSec);
          const deltaSec = (g.dx / Math.max(1, trackWidth)) * d;
          const next = clampStart(panOriginStartRef.current + deltaSec);
          startSecRef.current = next;
          setStartSec(next);
        },
        onPanResponderRelease: () => {
          isDraggingRef.current = false;
          const next = clampStart(startSecRef.current);
          startSecRef.current = next;
          setStartSec(next);
          panOriginStartRef.current = next;
          const s = soundRef.current;
          if (s) {
            void s
              .setPositionAsync(next * 1000)
              .then(() => s.playAsync())
              .catch(() => {});
          }
        },
      }),
    [songDurationSec, trackWidth, clampStart]
  );

  function onLayoutTrack(e: LayoutChangeEvent) {
    const w = e.nativeEvent.layout.width;
    if (w > 0) setTrackWidth(w);
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Song section</Text>
            <TouchableOpacity onPress={onClose} hitSlop={12} accessibilityLabel="Close">
              <Ionicons name="close" size={26} color="#64748b" />
            </TouchableOpacity>
          </View>
          <Text style={styles.hint}>
            Audio loops inside the highlighted {windowDurationSec}s window. Drag the window to pick a section (audio
            pauses while you drag, then plays from the new start).
          </Text>

          {loading ? (
            <ActivityIndicator size="large" color="#6366f1" style={{ marginVertical: 32 }} />
          ) : (
            <>
              <View style={styles.waveWrap}>
                {waveBars.map((h, i) => (
                  <View
                    key={i}
                    style={[
                      styles.bar,
                      {
                        flex: 1,
                        height: 8 + h * 44,
                        marginHorizontal: 0.5,
                        opacity: 0.35 + 0.5 * h,
                      },
                    ]}
                  />
                ))}
              </View>

              <View style={styles.trackOuter} onLayout={onLayoutTrack}>
                <View style={styles.trackBg} />
                <View
                  style={[
                    styles.selection,
                    {
                      width: selectionWidthPx,
                      left: Math.min(Math.max(0, selectionLeftPx), Math.max(0, trackWidth - selectionWidthPx)),
                    },
                  ]}
                  {...panResponder.panHandlers}
                >
                  <Text style={styles.selectionLabel}>{windowDurationSec}s</Text>
                </View>
              </View>

              <View style={styles.timeRow}>
                <Text style={styles.timeText}>Start {formatTime(startSec)}</Text>
                <Text style={styles.timeText}>End {formatTime(startSec + windowDurationSec)}</Text>
              </View>
              <Text style={styles.timeSub}>Track length {formatTime(songDurationSec)}</Text>

              <View style={styles.actions}>
                <TouchableOpacity
                  style={styles.confirmBtn}
                  onPress={() => {
                    onConfirm(clampStart(startSec));
                    onClose();
                  }}
                >
                  <Text style={styles.confirmBtnText}>Use this section</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(15,23,42,0.45)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingBottom: 28,
    paddingTop: 12,
    minHeight: 420,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#0f172a",
  },
  hint: {
    fontSize: 13,
    color: "#64748b",
    lineHeight: 18,
    marginBottom: 16,
  },
  waveWrap: {
    flexDirection: "row",
    alignItems: "flex-end",
    height: 56,
    marginBottom: 12,
  },
  bar: {
    backgroundColor: "#6366f1",
    borderRadius: 2,
    alignSelf: "flex-end",
  },
  trackOuter: {
    height: 44,
    marginTop: 4,
    position: "relative",
    justifyContent: "center",
  },
  trackBg: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#e2e8f0",
    borderRadius: 8,
  },
  selection: {
    position: "absolute",
    top: 4,
    bottom: 4,
    backgroundColor: "rgba(99,102,241,0.35)",
    borderWidth: 2,
    borderColor: "#6366f1",
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
  },
  selectionLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "#4338ca",
  },
  timeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 12,
  },
  timeText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#334155",
  },
  timeSub: {
    fontSize: 12,
    color: "#94a3b8",
    marginTop: 4,
  },
  actions: {
    marginTop: 20,
    gap: 12,
  },
  confirmBtn: {
    backgroundColor: "#6366f1",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  confirmBtnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 16,
  },
});
