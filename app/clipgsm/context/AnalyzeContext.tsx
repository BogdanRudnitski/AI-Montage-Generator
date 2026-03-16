import React, { createContext, useContext, useState, useCallback, ReactNode } from "react";

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
}

export interface MediaItemForPreview {
  uri: string;
  filename?: string;
}

interface AnalyzeContextValue {
  analyzeResult: AnalyzeResult | null;
  mediaList: MediaItemForPreview[];
  songUri: string | null;
  setAnalyzeResult: (r: AnalyzeResult | null) => void;
  setMediaListForPreview: (list: MediaItemForPreview[]) => void;
  setSongUri: (uri: string | null) => void;
  clear: () => void;
}

const AnalyzeContext = createContext<AnalyzeContextValue | null>(null);

export function AnalyzeProvider({ children }: { children: ReactNode }) {
  const [analyzeResult, setAnalyzeResult] = useState<AnalyzeResult | null>(null);
  const [mediaList, setMediaListForPreview] = useState<MediaItemForPreview[]>([]);
  const [songUri, setSongUri] = useState<string | null>(null);
  const clear = useCallback(() => {
    setAnalyzeResult(null);
    setMediaListForPreview([]);
    setSongUri(null);
  }, []);
  return (
    <AnalyzeContext.Provider
      value={{
        analyzeResult,
        mediaList,
        songUri,
        setAnalyzeResult,
        setMediaListForPreview,
        setSongUri,
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
