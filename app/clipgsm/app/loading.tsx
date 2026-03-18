import React, { useEffect, useState, useRef } from "react";
import { View, Text, StyleSheet, ActivityIndicator, Animated, Alert } from "react-native";
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

  console.log("[TRACE] loading mount/render", { params, isExport, mode: params.mode });
  const [status, setStatus] = useState(isExport ? "Preparing export…" : "Initializing...");
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const hasNavigated = useRef(false);

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.1,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        }),
      ])
    ).start();
  }, []);

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
    console.log("[TRACE] loading export: segments to send", {
      count: segments.length,
      fromRef: fromRef != null,
      bodyUndefined: body == null,
      firstSegment: first
        ? {
            startTime: first.startTime,
            endTime: first.endTime,
            clipFilename: first.clipFilename,
            clipStart: first.clipStart,
            clipEnd: first.clipEnd,
          }
        : null,
      lastSegment: last
        ? { startTime: last.startTime, endTime: last.endTime, clipEnd: last.clipEnd }
        : null,
    });

    const progressSteps = [
      { time: 500, progress: 15, status: "Exporting…" },
      { time: 2000, progress: 35, status: "Rendering segments…" },
      { time: 4000, progress: 55, status: "Mixing video…" },
      { time: 6000, progress: 75, status: "Finalizing…" },
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
        console.log("[TRACE] loading export: response", {
          success: data.success,
          error: data.error,
          final_video_name: data.final_video?.name,
          final_video_url: data.final_video?.url,
        });
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
          setStatus("Complete!");
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

    const progressSteps = [
      { time: 1000, progress: 10, status: "Analyzing audio..." },
      { time: 3000, progress: 25, status: "Detecting beats..." },
      { time: 5000, progress: 40, status: "Finding vocal patterns..." },
      { time: 8000, progress: 55, status: "Identifying bass drops..." },
      { time: 12000, progress: 70, status: "Cutting video segments..." },
      { time: 16000, progress: 85, status: "Syncing to music..." },
      { time: 20000, progress: 95, status: "Finalizing video..." },
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
          console.log("[TRACE] loading poll: skip (export mode)");
          return;
        }
        const res = await fetch(`${SERVER_URL}/latest-video`);
        const data = await res.json();
        if (data.found && !hasNavigated.current && !exportModeRef.current) {
          console.log("[TRACE] loading poll: navigating to result", { url: data.url, name: data.name });
          hasNavigated.current = true;
          clearInterval(pollInterval);
          setProgress(100);
          setStatus("Complete!");
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
        <Text style={styles.headerTitle}>{isExport ? "Exporting" : "Creating Magic"}</Text>
        <Text style={styles.headerSubtitle}>
          {isExport ? "Rendering your video…" : "Hang tight, AI is working..."}
        </Text>
      </View>

      <View style={styles.content}>
        <Animated.View 
          style={[
            styles.iconContainer,
            { transform: [{ scale: pulseAnim }] }
          ]}
        >
          <Text style={styles.icon}>✨</Text>
        </Animated.View>

        <View style={styles.progressContainer}>
          <View style={styles.progressBar}>
            <View style={[styles.progressFill, { width: `${progress}%` }]} />
          </View>
          <Text style={styles.progressText}>{progress}%</Text>
        </View>

        <Text style={styles.statusText}>{status}</Text>

        <View style={styles.loadingIndicator}>
          <ActivityIndicator size="large" color="#6366f1" />
        </View>

        <View style={styles.tipContainer}>
          <Text style={styles.tipLabel}>💡 Pro Tip</Text>
          <Text style={styles.tipText}>
            The AI analyzes your song for bass drops, vocal patterns, and rhythm changes to create perfectly timed cuts!
          </Text>
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
  iconContainer: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: "#fff",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 40,
    shadowColor: "#6366f1",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 8,
  },
  icon: {
    fontSize: 64,
  },
  progressContainer: {
    width: "100%",
    marginBottom: 24,
  },
  progressBar: {
    width: "100%",
    height: 8,
    backgroundColor: "#e2e8f0",
    borderRadius: 4,
    overflow: "hidden",
    marginBottom: 12,
  },
  progressFill: {
    height: "100%",
    backgroundColor: "#6366f1",
    borderRadius: 4,
  },
  progressText: {
    fontSize: 24,
    fontWeight: "800",
    color: "#6366f1",
    textAlign: "center",
  },
  statusText: {
    fontSize: 18,
    fontWeight: "700",
    color: "#0f172a",
    marginBottom: 32,
    textAlign: "center",
  },
  loadingIndicator: {
    marginBottom: 40,
  },
  tipContainer: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 24,
    width: "100%",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 14,
    elevation: 3,
  },
  tipLabel: {
    fontSize: 16,
    fontWeight: "800",
    color: "#6366f1",
    marginBottom: 12,
  },
  tipText: {
    fontSize: 15,
    color: "#475569",
    lineHeight: 22,
    fontWeight: "500",
  },
});