import React, { createContext, useContext, useState, useCallback, useRef, ReactNode } from "react";

export interface SegmentSpec {
  startTime: number;
  endTime: number;
  clipFilename: string;
  clipStart: number;
  clipEnd: number;
}

export interface AnalyzeResult {
  duration: number;
  max_duration: number;
  bpm: number;
  cut_points: unknown[];
  segments: SegmentSpec[];
  /** Offset in the full audio file matching the analyzed window (seconds). */
  song_start_sec?: number;
}

export interface MediaItemForPreview {
  uri: string;
  filename?: string;
}

interface AnalyzeContextValue {
  analyzeResult: AnalyzeResult | null;
  mediaList: MediaItemForPreview[];
  songUri: string | null;
  pendingExportSegments: SegmentSpec[] | null;
  /** Set synchronously before navigating to loading; read by loading screen so correct segments are sent. */
  exportSegmentsRef: React.MutableRefObject<SegmentSpec[] | null>;
  setAnalyzeResult: (r: AnalyzeResult | null) => void;
  setMediaListForPreview: (list: MediaItemForPreview[]) => void;
  setSongUri: (uri: string | null) => void;
  setPendingExportSegments: (segments: SegmentSpec[] | null) => void;
  clear: () => void;
}

const AnalyzeContext = createContext<AnalyzeContextValue | null>(null);

export function AnalyzeProvider({ children }: { children: ReactNode }) {
  const [analyzeResult, setAnalyzeResult] = useState<AnalyzeResult | null>(null);
  const [mediaList, setMediaListForPreview] = useState<MediaItemForPreview[]>([]);
  const [songUri, setSongUri] = useState<string | null>(null);
  const [pendingExportSegments, setPendingExportSegments] = useState<SegmentSpec[] | null>(null);
  const exportSegmentsRef = useRef<SegmentSpec[] | null>(null);
  const clear = useCallback(() => {
    setAnalyzeResult(null);
    setMediaListForPreview([]);
    setSongUri(null);
    setPendingExportSegments(null);
    exportSegmentsRef.current = null;
  }, []);
  return (
    <AnalyzeContext.Provider
      value={{
        analyzeResult,
        mediaList,
        songUri,
        pendingExportSegments,
        exportSegmentsRef,
        setAnalyzeResult,
        setMediaListForPreview,
        setSongUri,
        setPendingExportSegments,
        clear,
      }}
    >
      {children}
    </AnalyzeContext.Provider>
  );
}

export function useAnalyze() {
  const ctx = useContext(AnalyzeContext);
  if (!ctx) throw new Error("useAnalyze must be used within AnalyzeProvider");
  return ctx;
}
