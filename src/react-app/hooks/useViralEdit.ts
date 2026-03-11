import { useState, useCallback } from 'react';

const LOCAL_FFMPEG_URL = 'http://localhost:3333';

export interface EmphasisPoint {
  timestamp: number;
  word: string;
  confidence: number;
  type: 'emphasis' | 'punchline' | 'emotional' | 'pause' | 'exclamation';
  reason: string;
}

export interface SlowSection {
  startTime: number;
  endTime: number;
  reason: string;
  suggestion: string;
  confidence: number;
}

export interface ViralEditConfig {
  enableZoomCuts: boolean;
  enableKaraokeCaptions: boolean;
  enableSpeedBoost: boolean;
  zoomIntensity: number; // 1.1 - 1.5
  detectSlowSections: boolean;
}

export interface ViralEditProgress {
  step: string;
  percent: number;
}

export interface ViralEditResult {
  emphasisPoints: EmphasisPoint[];
  slowSections: SlowSection[];
  zoomCutsApplied: number;
  captionStyleUpdated: boolean;
}

export function useViralEdit(sessionId: string | undefined) {
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<ViralEditProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emphasisPoints, setEmphasisPoints] = useState<EmphasisPoint[]>([]);
  const [slowSections, setSlowSections] = useState<SlowSection[]>([]);
  const [result, setResult] = useState<ViralEditResult | null>(null);

  // Analyze emphasis points
  const analyzeEmphasis = useCallback(async (): Promise<EmphasisPoint[]> => {
    if (!sessionId) {
      setError('No active session');
      return [];
    }

    try {
      console.log('[useViralEdit] Analyzing emphasis points...');

      const response = await fetch(
        `${LOCAL_FFMPEG_URL}/session/${sessionId}/analyze-emphasis`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to analyze emphasis');
      }

      const data = await response.json();
      setEmphasisPoints(data.emphasisPoints || []);
      return data.emphasisPoints || [];
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Analysis failed';
      setError(message);
      return [];
    }
  }, [sessionId]);

  // Detect slow sections
  const detectSlow = useCallback(async (): Promise<SlowSection[]> => {
    if (!sessionId) {
      setError('No active session');
      return [];
    }

    try {
      console.log('[useViralEdit] Detecting slow sections...');

      const response = await fetch(
        `${LOCAL_FFMPEG_URL}/session/${sessionId}/detect-slow-sections`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to detect slow sections');
      }

      const data = await response.json();
      setSlowSections(data.slowSections || []);
      return data.slowSections || [];
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Detection failed';
      setError(message);
      return [];
    }
  }, [sessionId]);

  // Apply viral edits (orchestrates the full workflow)
  const applyViralEdits = useCallback(async (
    config: ViralEditConfig,
    callbacks?: {
      onApplyZoomCut?: (timestamp: number, scale: number) => void;
      onUpdateCaptionStyle?: (style: { animation: string; highlightColor: string }) => void;
    }
  ): Promise<ViralEditResult | null> => {
    if (!sessionId) {
      setError('No active session');
      return null;
    }

    setProcessing(true);
    setError(null);
    setResult(null);

    try {
      let emphasisData: EmphasisPoint[] = [];
      let slowData: SlowSection[] = [];
      let zoomCutsApplied = 0;

      // Step 1: Analyze emphasis points
      if (config.enableZoomCuts) {
        setProgress({ step: 'Analyzing speech patterns...', percent: 10 });
        emphasisData = await analyzeEmphasis();
      }

      // Step 2: Detect slow sections
      if (config.detectSlowSections) {
        setProgress({ step: 'Finding slow sections...', percent: 30 });
        slowData = await detectSlow();
      }

      // Step 3: Apply zoom cuts at emphasis points
      if (config.enableZoomCuts && emphasisData.length > 0 && callbacks?.onApplyZoomCut) {
        setProgress({ step: 'Applying zoom cuts...', percent: 50 });

        // Apply zoom to top emphasis points (sorted by confidence)
        const topPoints = [...emphasisData]
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 8); // Max 8 zoom cuts

        for (const point of topPoints) {
          callbacks.onApplyZoomCut(point.timestamp, config.zoomIntensity);
          zoomCutsApplied++;
        }
      }

      // Step 4: Update caption style
      if (config.enableKaraokeCaptions && callbacks?.onUpdateCaptionStyle) {
        setProgress({ step: 'Updating caption style...', percent: 70 });
        callbacks.onUpdateCaptionStyle({
          animation: 'karaoke',
          highlightColor: '#ff6b00',
        });
      }

      setProgress({ step: 'Complete!', percent: 100 });

      const finalResult: ViralEditResult = {
        emphasisPoints: emphasisData,
        slowSections: slowData,
        zoomCutsApplied,
        captionStyleUpdated: config.enableKaraokeCaptions,
      };

      setResult(finalResult);
      return finalResult;

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Viral edit failed';
      setError(message);
      return null;
    } finally {
      setProcessing(false);
      setTimeout(() => setProgress(null), 2000);
    }
  }, [sessionId, analyzeEmphasis, detectSlow]);

  // Clear state
  const clear = useCallback(() => {
    setEmphasisPoints([]);
    setSlowSections([]);
    setResult(null);
    setError(null);
    setProgress(null);
  }, []);

  return {
    processing,
    progress,
    error,
    emphasisPoints,
    slowSections,
    result,
    analyzeEmphasis,
    detectSlow,
    applyViralEdits,
    clear,
  };
}
