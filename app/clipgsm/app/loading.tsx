import React, { useEffect, useState, useRef } from "react";
import { View, Text, StyleSheet, ActivityIndicator, Alert } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { SERVER_URL } from "../config";
import { useAnalyze } from "../context/AnalyzeContext";

export default function LoadingScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ mode?: string }>();
  const { pendingExportSegments, setPendingExportSegments, exportSegmentsRef } = useAnalyze();
  const isExport = params.mode === "export";
  const exportModeRef = useRef(isExport);
  exportModeRef.current = isExport;
  const exportStartedRef = useRef(false);

  const [progress, setProgress] = useState(0);

  const [status, setStatus] = useState(isExport ? "Preparing export" : "Initializing");
  const hasNavigated = useRef(false);

  // Export mode: run POST /export, then navigate to result
  useEffect(() => {
    if (!isExport) return;
    // Only run once so we don't send a second request with stale/empty segments (e.g. React Strict Mode double-mount).
    if (exportStartedRef.current) return;
    exportStartedRef.current = true;

    // Prefer ref (set synchronously before navigate); state may still be stale when we mount.
    const fromRef = exportSegmentsRef.current;
    const segments = fromRef ?? pendingExportSegments ?? [];
    exportSegmentsRef.current = null;
    const body = segments.length > 0 ? { segments } : undefined;
    const first = segments[0];
    const last = segments.length > 0 ? segments[segments.length - 1] : null;
    // Fake progress: keep it slower + lower so it doesn't "race ahead" of real work.
    const progressSteps = [
      { time: 900, progress: 12, status: "Exporting" },
      { time: 3200, progress: 28, status: "Rendering segments" },
      { time: 6200, progress: 48, status: "Mixing video" },
      { time: 10500, progress: 68, status: "Finalizing" },
    ];
    progressSteps.forEach(({ time, progress: p, status: s }) => {
      setTimeout(() => {
        setProgress(p);
        setStatus(s);
      }, time);
    });

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${SERVER_URL}/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });
        const data = await res.json();
        if (cancelled || hasNavigated.current) return;
        if (!data.success) {
          setPendingExportSegments(null);
          Alert.alert("Export Failed", data.error || "Unknown error", [
            { text: "OK", onPress: () => router.replace("/preview") },
          ]);
          return;
        }
        const video = data.final_video;
        if (video?.url != null && video?.name != null) {
          hasNavigated.current = true;
          setProgress(100);
          setStatus("Complete");
          setPendingExportSegments(null);
          setTimeout(() => {
            router.replace({
              pathname: "/result",
              params: { videoUrl: video.url, videoName: video.name },
            });
          }, 400);
        } else {
          setPendingExportSegments(null);
          Alert.alert("Export Failed", "No video returned.", [
            { text: "OK", onPress: () => router.replace("/preview") },
          ]);
        }
      } catch (err) {
        if (cancelled || hasNavigated.current) return;
        console.error(err);
        setPendingExportSegments(null);
        Alert.alert("Export Failed", "Check your network connection.", [
          { text: "OK", onPress: () => router.replace("/preview") },
        ]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isExport]);

  // Legacy mode: poll /latest-video (e.g. when navigated without mode=export)
  useEffect(() => {
    if (isExport) return;

    // Fake progress: slower ramp so it doesn't feel stuck at the end or jump too fast.
    const progressSteps = [
      { time: 1400, progress: 8, status: "Analyzing audio..." },
      { time: 4600, progress: 22, status: "Detecting beats..." },
      { time: 7600, progress: 38, status: "Finding vocal patterns..." },
      { time: 11500, progress: 55, status: "Identifying bass drops..." },
      { time: 16500, progress: 70, status: "Cutting video segments..." },
      { time: 21500, progress: 82, status: "Syncing to music..." },
      { time: 26500, progress: 90, status: "Finalizing video..." },
    ];
    progressSteps.forEach(({ time, progress: p, status: s }) => {
      setTimeout(() => {
        setProgress(p);
        setStatus(s);
      }, time);
    });

    const pollInterval = setInterval(async () => {
      try {
        if (exportModeRef.current) {
          return;
        }
        const res = await fetch(`${SERVER_URL}/latest-video`);
        const data = await res.json();
        if (data.found && !hasNavigated.current && !exportModeRef.current) {
          hasNavigated.current = true;
          clearInterval(pollInterval);
          setProgress(100);
          setStatus("Complete");
          setTimeout(() => {
            router.push({
              pathname: "/result",
              params: { videoUrl: data.url, videoName: data.name },
            });
          }, 500);
        }
      } catch (err) {
        console.error("Poll error:", err);
      }
    }, 2000);
    return () => clearInterval(pollInterval);
  }, [isExport]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{isExport ? "Exporting" : "Creating video"}</Text>
        <Text style={styles.headerSubtitle}>
          {isExport ? "Rendering your video" : "Analyzing audio + preparing cuts"}
        </Text>
      </View>

      <View style={styles.content}>
        <View style={styles.card}>
          <View style={styles.progressContainer}>
            <View style={styles.progressBar}>
              <View style={[styles.progressFill, { width: `${progress}%` }]} />
            </View>
          </View>

          <Text style={styles.statusText}>{status}</Text>
          <ActivityIndicator size="small" color="#6366f1" />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f7fb",
  },
  header: {
    backgroundColor: "#6366f1",
    paddingTop: 60,
    paddingBottom: 30,
    paddingHorizontal: 24,
  },
  headerTitle: {
    fontSize: 36,
    fontWeight: "900",
    color: "#fff",
    marginBottom: 6,
    letterSpacing: -0.5,
  },
  headerSubtitle: {
    fontSize: 17,
    color: "rgba(255, 255, 255, 0.95)",
    fontWeight: "600",
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 60,
    alignItems: "center",
  },
  card: {
    width: "100%",
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 20,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 14,
    elevation: 3,
    alignItems: "center",
  },
  progressContainer: {
    width: "100%",
    marginBottom: 12,
  },
  progressBar: {
    width: "100%",
    height: 8,
    backgroundColor: "#e2e8f0",
    borderRadius: 4,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: "#6366f1",
    borderRadius: 4,
  },
  statusText: {
    fontSize: 18,
    fontWeight: "700",
    color: "#0f172a",
    marginBottom: 10,
    textAlign: "center",
  },
});