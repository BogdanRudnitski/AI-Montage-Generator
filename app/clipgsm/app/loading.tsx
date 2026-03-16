import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, Animated } from "react-native";
import { useRouter } from "expo-router";

const SERVER_URL = "http://10.122.245.118:8000";

export default function LoadingScreen() {
  const router = useRouter();
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Initializing...");
  const pulseAnim = new Animated.Value(1);
  const hasNavigated = React.useRef(false);

  useEffect(() => {
    // Pulse animation
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

    // Simulate progress
    const progressSteps = [
      { time: 1000, progress: 10, status: "Analyzing audio..." },
      { time: 3000, progress: 25, status: "Detecting beats..." },
      { time: 5000, progress: 40, status: "Finding vocal patterns..." },
      { time: 8000, progress: 55, status: "Identifying bass drops..." },
      { time: 12000, progress: 70, status: "Cutting video segments..." },
      { time: 16000, progress: 85, status: "Syncing to music..." },
      { time: 20000, progress: 95, status: "Finalizing video..." },
    ];

    progressSteps.forEach(({ time, progress, status }) => {
      setTimeout(() => {
        setProgress(progress);
        setStatus(status);
      }, time);
    });

    // Poll for completion
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`${SERVER_URL}/latest-video`);
        const data = await res.json();
        
        if (data.found && !hasNavigated.current) {
          hasNavigated.current = true;
          clearInterval(pollInterval);
          setProgress(100);
          setStatus("Complete!");
          
          setTimeout(() => {
            router.push({
              pathname: "/result",
              params: { 
                videoUrl: data.url,
                videoName: data.name
              }
            });
          }, 500);
        }
      } catch (err) {
        console.error("Poll error:", err);
      }
    }, 2000);

    return () => clearInterval(pollInterval);
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Creating Magic</Text>
        <Text style={styles.headerSubtitle}>Hang tight, AI is working...</Text>
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