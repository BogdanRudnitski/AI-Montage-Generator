import React, { useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import TimelineStrip, { SegmentRecord } from "../components/TimelineStrip";

const DEMO_SEGMENTS: SegmentRecord[] = [
  { startTime: 0, endTime: 5, clipFilename: "demo1", clipStart: 0, clipEnd: 10 },
  { startTime: 5, endTime: 15, clipFilename: "demo2", clipStart: 0, clipEnd: 10 },
  { startTime: 15, endTime: 25, clipFilename: "demo3", clipStart: 0, clipEnd: 10 },
  { startTime: 25, endTime: 35, clipFilename: "demo4", clipStart: 0, clipEnd: 10 },
];

export default function TimelineDemoScreen() {
  const router = useRouter();
  const [segments, setSegments] = useState<SegmentRecord[]>(DEMO_SEGMENTS);
  const [playheadTime, setPlayheadTime] = useState(0);
  const [selectedSegmentIndex, setSelectedSegmentIndex] = useState<number | null>(null);
  const [timelineScrollX, setTimelineScrollX] = useState(0);
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(0);
  const [secondsPerViewport, setSecondsPerViewport] = useState(10);
  const [stripKey, setStripKey] = useState(0);
  const [resizeMode, setResizeMode] = useState<"moveCut" | "trim">("moveCut");
  const timelineScrollRef = useRef<ScrollView>(null);
  const totalDuration = segments.length > 0 ? segments[segments.length - 1].endTime : 0;
  const thumbnailUris = segments.map(() => null);

  const handleRefreshTimeline = () => {
    setStripKey((k) => k + 1);
    Alert.alert("Refresh", "Timeline remounted with current state. If blocks look resized, state is saving correctly.");
  };

  const handleLogSegments = () => {
    const json = JSON.stringify(segments, null, 2);
    console.log("[TimelineDemo] segments JSON:", json);
    const summary = segments
      .map((s, i) => `#${i}: ${s.startTime.toFixed(1)}–${s.endTime.toFixed(1)}s`)
      .join("\n");
    Alert.alert("Segments (current state)", `totalDuration: ${totalDuration.toFixed(1)}s\n\n${summary}`);
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Timeline demo</Text>
      </View>
      <View style={styles.instructions}>
        <Text style={styles.instructionsText}>
          Tap a clip to select it (purple borders). Drag the left or right border to resize. Drag near the playhead line to scrub.
        </Text>
      </View>
      <View style={styles.debugRow}>
        <TouchableOpacity style={styles.debugButton} onPress={handleRefreshTimeline}>
          <Text style={styles.debugButtonText}>Refresh timeline</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.debugButton} onPress={handleLogSegments}>
          <Text style={styles.debugButtonText}>Log segments</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.debugButton, resizeMode === "trim" && styles.debugButtonActive]}
          onPress={() => setResizeMode((m) => (m === "moveCut" ? "trim" : "moveCut"))}
        >
          <Text style={styles.debugButtonText}>
            {resizeMode === "moveCut" ? "Move cut" : "Trim"}
          </Text>
        </TouchableOpacity>
      </View>
      <TimelineStrip
        key={stripKey}
        segments={segments}
        totalDuration={totalDuration}
        playheadTime={playheadTime}
        onPlayheadChange={setPlayheadTime}
        onSegmentsChange={(next) => {
          if (__DEV__ && next?.length) {
            const summary = next
              .map((s, i) => `#${i}: ${s.startTime.toFixed(2)}–${s.endTime.toFixed(2)}`)
              .join(", ");
            console.log("[TimelineDemo] onSegmentsChange", next.length, "segments:", summary);
          }
          setSegments((_prev) => next);
        }}
        selectedSegmentIndex={selectedSegmentIndex}
        onSelectSegment={setSelectedSegmentIndex}
        thumbnailUris={thumbnailUris}
        timelineScrollX={timelineScrollX}
        onTimelineScrollChange={setTimelineScrollX}
        timelineViewportWidth={timelineViewportWidth}
        onTimelineViewportLayout={setTimelineViewportWidth}
        timelineScrollRef={timelineScrollRef}
        resizeMode={resizeMode}
        secondsPerViewport={secondsPerViewport}
        onSecondsPerViewportChange={setSecondsPerViewport}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f5f7fb" },
  header: {
    backgroundColor: "#6366f1",
    paddingTop: 60,
    paddingBottom: 16,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    justifyContent: "center",
    alignItems: "center",
  },
  headerTitle: { fontSize: 20, fontWeight: "700", color: "#fff" },
  instructions: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#e0e7ff",
  },
  instructionsText: {
    fontSize: 14,
    color: "#3730a3",
    lineHeight: 20,
  },
  debugRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: "#fef3c7",
  },
  debugButtonActive: { backgroundColor: "#6366f1", opacity: 1 },
  debugButton: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: "#f59e0b",
    borderRadius: 8,
    alignItems: "center",
  },
  debugButtonText: { color: "#fff", fontSize: 13, fontWeight: "600" },
});
