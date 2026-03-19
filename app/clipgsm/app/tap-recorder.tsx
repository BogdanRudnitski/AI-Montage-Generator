import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Animated, Platform, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
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
  const { songName, songUri } = useLocalSearchParams<{ songName?: string; songUri?: string }>();
  const safeSongName = typeof songName === "string" ? songName : "Song";
  const safeSongUri = typeof songUri === "string" ? songUri : "";

  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const positionMsRef = useRef(0); // always current — avoids stale state capture in handleTap
  const [durationMs, setDurationMs] = useState(1);
  const [cuts, setCuts] = useState<ManualCut[]>([]);
  const [saving, setSaving] = useState(false);
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const MAX_RECORD_MS = 60000;
  const durationSafe = Math.max(Math.min(durationMs, MAX_RECORD_MS), 1);
  const progress = Math.max(0, Math.min(1, positionMs / durationSafe));
  const cutsCountLabel = `${cuts.length} cuts`;

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!safeSongName) return;
      try {
        const res = await fetch(`${SERVER_URL}/api/taps/${encodeURIComponent(safeSongName)}`);
        const data = await res.json();
        if (!mounted) return;
        const loaded = (data.manual_cuts || []).map((c: any, i: number) => {
          const ts = Number((Number(c.timestamp) || 0).toFixed(3));
          return {
            index: i + 1,
            timestamp: ts,
            timestamp_fmt: c.timestamp_fmt || formatTimestamp(ts),
          } as ManualCut;
        });
        setCuts(loaded);
      } catch {
        // ignore, user can still tap
      }
    })();
    return () => {
      mounted = false;
    };
  }, [safeSongName]);

  useEffect(() => {
    let mounted = true;
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
        const created = await Audio.Sound.createAsync(
          { uri: safeSongUri },
          { shouldPlay: false },
          (status: AVPlaybackStatus) => {
            if (!status.isLoaded) return;
            const nextPos = status.positionMillis ?? 0;
            const nextDur = status.durationMillis ?? 1;
            positionMsRef.current = Math.min(nextPos, MAX_RECORD_MS);
            setPositionMs(Math.min(nextPos, MAX_RECORD_MS));
            setDurationMs(Math.min(nextDur, MAX_RECORD_MS));
            setIsPlaying(Boolean(status.isPlaying));
            if ((status.positionMillis ?? 0) >= MAX_RECORD_MS && status.isPlaying) {
              created.sound.pauseAsync().catch(() => {});
            }
          }
        );
        if (!mounted) {
          await created.sound.unloadAsync();
          return;
        }
        await created.sound.setProgressUpdateIntervalAsync(16);
        setSound(created.sound);
      } catch {
        Alert.alert("Audio error", "Could not load the selected song.");
      }
    })();
    return () => {
      mounted = false;
      if (sound) sound.unloadAsync().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeSongUri]);

  const handleTap = useCallback(() => {
    const ts = Number((positionMsRef.current / 1000).toFixed(3));
    const next = cuts.length + 1;
    Animated.sequence([
      Animated.timing(scaleAnim, { toValue: 0.9, duration: 35, useNativeDriver: true }),
      Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, speed: 40, bounciness: 5 }),
    ]).start();
    setCuts((prev) => [...prev, { index: next, timestamp: ts, timestamp_fmt: formatTimestamp(ts) }]);
  }, [cuts.length, scaleAnim]);

  const togglePlay = useCallback(async () => {
    if (!sound) return;
    const status = await sound.getStatusAsync();
    if (!status.isLoaded) return;
    if (status.isPlaying) await sound.pauseAsync();
    else await sound.playAsync();
  }, [sound]);

  const seekToRatio = useCallback(
    async (ratio: number) => {
      if (!sound) return;
      const next = Math.max(0, Math.min(1, ratio));
      await sound.setPositionAsync(Math.min(next * durationSafe, MAX_RECORD_MS));
    },
    [sound, durationSafe]
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
          manual_cuts: cuts,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to save");
      Alert.alert("Saved", `${data.cut_count ?? cuts.length} cuts saved`);
      router.back();
    } catch {
      Alert.alert("Save failed", "Could not save taps.");
    } finally {
      setSaving(false);
    }
  }, [cuts, safeSongName, saving]);

  const recentChips = useMemo(() => [...cuts].reverse(), [cuts]);

  return (
    <View style={styles.screen}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={styles.topAction}>
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
          const w = e.nativeEvent.layout?.width ?? 1;
          const x = e.nativeEvent.locationX ?? 0;
          seekToRatio(x / w);
        }}
      >
        <View style={styles.progressTrack}>
          <View style={[styles.playhead, { left: `${progress * 100}%` }]} />
          {cuts.map((c) => {
            const left = `${Math.max(0, Math.min(100, ((c.timestamp * 1000) / durationSafe) * 100))}%`;
            return <View key={`${c.index}-${c.timestamp}`} style={[styles.marker, { left }]} />;
          })}
        </View>
      </Pressable>
      <View style={styles.scrubberWrap}>
        <Slider
          style={styles.scrubber}
          minimumValue={0}
          maximumValue={durationSafe}
          value={positionMs}
          onSlidingComplete={(value) => seekToRatio(value / durationSafe)}
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
        <Text style={styles.tapLabel}>Tap to cut</Text>
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
          {recentChips.map((c) => (
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