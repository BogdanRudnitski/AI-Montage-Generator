import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Animated, BackHandler, Platform, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Audio, AVPlaybackStatus } from "expo-av";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { SERVER_URL } from "../config";
import Slider from "@react-native-community/slider";

type ManualCut = {
  index: number;
  timestamp: number;
  timestamp_fmt: string;
};

function formatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

export default function TapRecorderScreen() {
  const { songName, songUri, songStartSec, windowDurationSec } = useLocalSearchParams<{
    songName?: string;
    songUri?: string;
    songStartSec?: string;
    windowDurationSec?: string;
  }>();
  const safeSongName = typeof songName === "string" ? songName : "Song";
  const safeSongUri = typeof songUri === "string" ? songUri : "";
  const rangeStartSec = Math.max(0, Number(songStartSec ?? 0) || 0);
  const selectedWindowSec = Math.max(1, Number(windowDurationSec ?? 60) || 60);

  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const positionMsRef = useRef(0); // always current — avoids stale state capture in handleTap
  const [durationMs, setDurationMs] = useState(1);
  const [cuts, setCuts] = useState<ManualCut[]>([]);
  const [persistedCutsOutsideRange, setPersistedCutsOutsideRange] = useState<ManualCut[]>([]);
  const [loadingTaps, setLoadingTaps] = useState(false);
  const [saving, setSaving] = useState(false);
  const [trackWidth, setTrackWidth] = useState(1);
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const soundRef = useRef<Audio.Sound | null>(null);

  const rangeStartMs = rangeStartSec * 1000;
  /** Full selected window length (e.g. 60s), independent of taps; shrink only if file ends early. */
  const windowMs = Math.max(1, selectedWindowSec * 1000);
  const fileLoaded = durationMs > rangeStartMs + 250;
  const rangeDurationMs = Math.max(
    1,
    fileLoaded ? Math.min(windowMs, Math.max(1, durationMs - rangeStartMs)) : windowMs
  );
  const rangeEndMs = rangeStartMs + rangeDurationMs;
  const localPositionMs = Math.max(0, Math.min(rangeDurationMs, positionMs - rangeStartMs));
  const progress = Math.max(0, Math.min(1, localPositionMs / rangeDurationMs));
  const cutsCountLabel = `${cuts.length} cuts`;

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!safeSongName) return;
      setLoadingTaps(true);
      try {
        const res = await fetch(`${SERVER_URL}/api/taps/${encodeURIComponent(safeSongName)}`);
        const data = await res.json();
        if (!mounted) return;
        const all = (data.manual_cuts || []).map((c: any, i: number) => {
          const ts = Number((Number(c.timestamp) || 0).toFixed(3));
          return {
            index: i + 1,
            timestamp: ts,
            timestamp_fmt: c.timestamp_fmt || formatTimestamp(ts),
          } as ManualCut;
        });
        const inRange = all.filter((c: ManualCut) => c.timestamp >= rangeStartSec - 1e-6 && c.timestamp <= (rangeStartSec + selectedWindowSec + 1e-6));
        const outRange = all.filter((c: ManualCut) => c.timestamp < rangeStartSec - 1e-6 || c.timestamp > (rangeStartSec + selectedWindowSec + 1e-6));
        setCuts(inRange.map((c: ManualCut, i: number) => ({ ...c, index: i + 1 })));
        setPersistedCutsOutsideRange(outRange);
      } catch {
        // ignore, user can still tap
      } finally {
        if (mounted) setLoadingTaps(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [safeSongName, rangeStartSec, selectedWindowSec]);

  const stopAndUnloadSound = useCallback(async () => {
    const s = soundRef.current;
    soundRef.current = null;
    setSound(null);
    setIsPlaying(false);
    if (!s) return;
    try {
      await s.stopAsync();
    } catch {
      /* ignore */
    }
    try {
      await s.unloadAsync();
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    let createdSound: Audio.Sound | null = null;
    const playbackHolderRef = { current: null as Audio.Sound | null };
    (async () => {
      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
          shouldDuckAndroid: true,
          playThroughEarpieceAndroid: false,
          staysActiveInBackground: false,
        });
        if (!safeSongUri) return;
        const rangeStart = rangeStartSec * 1000;
        const winLen = Math.max(1, selectedWindowSec * 1000);
        const created = await Audio.Sound.createAsync(
          { uri: safeSongUri },
          { shouldPlay: false },
          (status: AVPlaybackStatus) => {
            if (!status.isLoaded) return;
            const sn = playbackHolderRef.current;
            if (!sn) return;
            const nextPos = status.positionMillis ?? 0;
            const nextDur = status.durationMillis ?? 1;
            const endMs = rangeStart + Math.min(winLen, Math.max(1, nextDur - rangeStart));
            positionMsRef.current = nextPos;
            setPositionMs(nextPos);
            setDurationMs(nextDur);
            setIsPlaying(Boolean(status.isPlaying));
            if (status.isPlaying && nextPos >= endMs - 30) {
              sn.setPositionAsync(rangeStart).catch(() => {});
            }
          }
        );
        createdSound = created.sound;
        playbackHolderRef.current = created.sound;
        if (!mounted) {
          await created.sound.unloadAsync();
          playbackHolderRef.current = null;
          return;
        }
        await created.sound.setProgressUpdateIntervalAsync(16);
        await created.sound.setPositionAsync(rangeStart);
        soundRef.current = created.sound;
        setSound(created.sound);
        await created.sound.playAsync();
      } catch {
        Alert.alert("Audio error", "Could not load the selected song.");
      }
    })();
    return () => {
      mounted = false;
      if (createdSound) {
        createdSound.stopAsync().catch(() => {});
        createdSound.unloadAsync().catch(() => {});
        soundRef.current = null;
      }
    };
  }, [safeSongUri, rangeStartSec, selectedWindowSec]);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      void stopAndUnloadSound();
      router.back();
      return true;
    });
    return () => sub.remove();
  }, [stopAndUnloadSound]);

  const handleTap = useCallback(() => {
    const ts = Number((positionMsRef.current / 1000).toFixed(3)); // absolute song timestamp
    const next = cuts.length + 1;
    Animated.sequence([
      Animated.timing(scaleAnim, { toValue: 0.9, duration: 35, useNativeDriver: true }),
      Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, speed: 40, bounciness: 5 }),
    ]).start();
    setCuts((prev) => [...prev, { index: next, timestamp: ts, timestamp_fmt: formatTimestamp(ts) }]);
  }, [cuts.length, scaleAnim]);

  const togglePlay = useCallback(async () => {
    const sn = soundRef.current;
    if (!sn) return;
    const status = await sn.getStatusAsync();
    if (!status.isLoaded) return;
    if (status.isPlaying) await sn.pauseAsync();
    else await sn.playAsync();
  }, []);

  const seekToRatio = useCallback(
    async (ratio: number) => {
      const sn = soundRef.current;
      if (!sn) return;
      const next = Math.max(0, Math.min(1, ratio));
      await sn.setPositionAsync(rangeStartMs + next * rangeDurationMs);
    },
    [rangeDurationMs, rangeStartMs]
  );

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.key.toLowerCase() === "t" || e.key === "Enter") {
        e.preventDefault();
        handleTap();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleTap, togglePlay]);

  const saveCuts = useCallback(async () => {
    if (!safeSongName || cuts.length < 1 || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`${SERVER_URL}/api/taps/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          song_filename: safeSongName,
          recorded_at: new Date().toISOString(),
          manual_cuts: [...persistedCutsOutsideRange, ...cuts]
            .sort((a, b) => a.timestamp - b.timestamp)
            .map((c, i) => ({ ...c, index: i + 1 })),
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to save");
      Alert.alert("Saved", `${data.cut_count ?? cuts.length} cuts saved`);
      await stopAndUnloadSound();
      router.back();
    } catch {
      Alert.alert("Save failed", "Could not save taps.");
    } finally {
      setSaving(false);
    }
  }, [cuts, persistedCutsOutsideRange, safeSongName, saving, stopAndUnloadSound]);

  const recentChips = useMemo(() => [...cuts].reverse(), [cuts]);

  return (
    <View style={styles.screen}>
      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={async () => {
            await stopAndUnloadSound();
            router.back();
          }}
          style={styles.topAction}
        >
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.songTitle} numberOfLines={1}>
          {safeSongName}
        </Text>
        <TouchableOpacity disabled={cuts.length < 1 || saving} onPress={saveCuts} style={[styles.saveBtn, (cuts.length < 1 || saving) && styles.saveBtnDisabled]}>
          <Text style={styles.saveBtnText}>{saving ? "Saving" : "Save"}</Text>
        </TouchableOpacity>
      </View>

      <Pressable
        style={styles.progressWrap}
        onPress={(e) => {
          const w = trackWidth || 1;
          const x = e.nativeEvent.locationX ?? 0;
          seekToRatio(x / w);
        }}
      >
        <View
          style={styles.progressTrack}
          onLayout={(e) => setTrackWidth(Math.max(1, e.nativeEvent.layout.width))}
        >
          <View style={[styles.playhead, { left: progress * trackWidth }]} />
          {cuts.map((c) => {
            const left =
              Math.max(0, Math.min(1, ((c.timestamp - rangeStartSec) * 1000) / rangeDurationMs)) *
              trackWidth;
            return <View key={`${c.index}-${c.timestamp}`} style={[styles.marker, { left }]} />;
          })}
        </View>
      </Pressable>
      <View style={styles.scrubberWrap}>
        <Slider
          style={styles.scrubber}
          minimumValue={0}
          maximumValue={rangeDurationMs}
          value={localPositionMs}
          onSlidingComplete={(value) => seekToRatio(value / rangeDurationMs)}
          minimumTrackTintColor="#6366f1"
          maximumTrackTintColor="#475569"
          thumbTintColor="#fff"
        />
      </View>

      <View style={styles.tapZone}>
        <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
          <TouchableOpacity activeOpacity={0.9} onPress={handleTap} style={styles.tapCircle}>
            <Ionicons name="hand-left" size={48} color="#fff" />
          </TouchableOpacity>
        </Animated.View>
        <Text style={styles.tapLabel}>Tap to cut ({formatTimestamp(rangeStartSec)} to {formatTimestamp(rangeStartSec + selectedWindowSec)})</Text>
      </View>

      <View style={styles.bottomSheet}>
        <TouchableOpacity onPress={togglePlay} style={styles.playBtn}>
          <Ionicons name={isPlaying ? "pause" : "play"} size={48} color="#6366f1" />
        </TouchableOpacity>
        <View style={styles.bottomRow}>
          <TouchableOpacity style={styles.rowBtn} onPress={() => setCuts((prev) => prev.slice(0, -1))} disabled={cuts.length === 0}>
            <Ionicons name="trash-outline" size={18} color="#64748b" />
            <Text style={styles.rowBtnText}>Undo</Text>
          </TouchableOpacity>
          <View style={styles.countBadge}>
            <Text style={styles.countBadgeText}>{cutsCountLabel}</Text>
          </View>
          <TouchableOpacity style={styles.rowBtn} onPress={() => setCuts([])} disabled={cuts.length === 0}>
            <Ionicons name="close" size={18} color="#64748b" />
            <Text style={styles.rowBtnText}>Clear</Text>
          </TouchableOpacity>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
          {loadingTaps ? (
            <View style={styles.chip}>
              <Text style={styles.chipText}>Loading taps...</Text>
            </View>
          ) : recentChips.map((c) => (
            <View key={`chip-${c.index}-${c.timestamp}`} style={styles.chip}>
              <Text style={styles.chipText}>{c.timestamp_fmt}</Text>
            </View>
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000" },
  topBar: { paddingTop: 56, paddingHorizontal: 16, paddingBottom: 12, flexDirection: "row", alignItems: "center" },
  topAction: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center" },
  songTitle: { flex: 1, color: "#fff", fontSize: 16, fontWeight: "700", textAlign: "center", marginHorizontal: 8 },
  saveBtn: { backgroundColor: "#6366f1", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  saveBtnDisabled: { backgroundColor: "#cbd5e1" },
  saveBtnText: { color: "#fff", fontWeight: "700" },
  progressWrap: { paddingHorizontal: 12, height: 48, justifyContent: "center" },
  progressTrack: { height: 36, borderRadius: 10, backgroundColor: "#1f2937", overflow: "hidden", position: "relative" },
  scrubberWrap: { paddingHorizontal: 10, marginTop: 2, marginBottom: 8 },
  scrubber: { width: "100%", height: 28 },
  playhead: { position: "absolute", top: 0, bottom: 0, width: 2, backgroundColor: "#fff", zIndex: 10 },
  marker: { position: "absolute", top: 0, bottom: 0, width: 2, backgroundColor: "#6366f1" },
  tapZone: { flex: 1, backgroundColor: "#0f172a", alignItems: "center", justifyContent: "center" },
  tapCircle: { width: 200, height: 200, borderRadius: 100, backgroundColor: "#6366f1", alignItems: "center", justifyContent: "center" },
  tapLabel: { marginTop: 16, color: "#fff", fontSize: 16, fontWeight: "600" },
  bottomSheet: { backgroundColor: "#fff", borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20 },
  playBtn: { alignSelf: "center", marginBottom: 14 },
  bottomRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  rowBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, paddingHorizontal: 8 },
  rowBtnText: { color: "#64748b", fontWeight: "700" },
  countBadge: { backgroundColor: "#eef2ff", paddingHorizontal: 12, paddingVertical: 4, borderRadius: 10 },
  countBadgeText: { color: "#6366f1", fontWeight: "700" },
  chipsRow: { gap: 8, paddingBottom: 4 },
  chip: { backgroundColor: "#eef2ff", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  chipText: { color: "#6366f1", fontWeight: "700" },
});