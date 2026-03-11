import { useState, useCallback } from 'react';

const LOCAL_FFMPEG_URL = 'http://localhost:3333';
const STORAGE_KEY = 'clipwise-shorts-candidates';

export interface ShortCandidate {
  id: string;
  startTime: number;
  endTime: number;
  duration: number;
  viralityScore: number;
  viralityFactors: string[];
  suggestedHook: string;
  suggestedTitle: string;
  suggestedDescription: string;
  thumbnailUrl: string | null;
  selected: boolean;
}

export interface RepurposeConfig {
  targetPlatform: 'tiktok' | 'youtube-shorts' | 'instagram-reels';
  maxDuration: number;
  minDuration: number;
  targetCount: number;
  cropTo916: boolean;
}

export interface ShortExport {
  candidateId: string;
  filename: string;
  downloadUrl: string;
  status: 'pending' | 'rendering' | 'complete' | 'error';
  error?: string;
}

export function useContentRepurpose(sessionId: string | undefined) {
  const [candidates, setCandidates] = useState<ShortCandidate[]>(() => {
    if (!sessionId) return [];
    try {
      const stored = localStorage.getItem(`${STORAGE_KEY}-${sessionId}`);
      if (stored) return JSON.parse(stored);
    } catch {}
    return [];
  });
  const [exports, setExports] = useState<ShortExport[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ current: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analyzedAssetId, setAnalyzedAssetId] = useState<string | null>(null);

  // Persist candidates
  const persistCandidates = useCallback((newCandidates: ShortCandidate[]) => {
    if (!sessionId) return;
    localStorage.setItem(`${STORAGE_KEY}-${sessionId}`, JSON.stringify(newCandidates));
  }, [sessionId]);

  // Analyze video for short candidates
  const analyzeForShorts = useCallback(async (config: RepurposeConfig): Promise<ShortCandidate[]> => {
    if (!sessionId) {
      setError('No active session');
      return [];
    }

    setAnalyzing(true);
    setError(null);

    try {
      console.log('[useContentRepurpose] Analyzing for shorts...', config);

      const response = await fetch(
        `${LOCAL_FFMPEG_URL}/session/${sessionId}/analyze-for-shorts`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config),
        }
      );

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Analysis failed');
      }

      const result = await response.json();
      console.log('[useContentRepurpose] Found:', result.candidates?.length, 'candidates');

      const newCandidates = result.candidates || [];
      setCandidates(newCandidates);
      setAnalyzedAssetId(result.analyzedAssetId);
      persistCandidates(newCandidates);

      return newCandidates;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Analysis failed';
      setError(message);
      return [];
    } finally {
      setAnalyzing(false);
    }
  }, [sessionId, persistCandidates]);

  // Toggle candidate selection
  const toggleCandidate = useCallback((id: string) => {
    setCandidates(prev => {
      const updated = prev.map(c =>
        c.id === id ? { ...c, selected: !c.selected } : c
      );
      persistCandidates(updated);
      return updated;
    });
  }, [persistCandidates]);

  // Select/deselect all
  const selectAll = useCallback((selected: boolean) => {
    setCandidates(prev => {
      const updated = prev.map(c => ({ ...c, selected }));
      persistCandidates(updated);
      return updated;
    });
  }, [persistCandidates]);

  // Update candidate details
  const updateCandidate = useCallback((id: string, updates: Partial<ShortCandidate>) => {
    setCandidates(prev => {
      const updated = prev.map(c =>
        c.id === id ? { ...c, ...updates } : c
      );
      persistCandidates(updated);
      return updated;
    });
  }, [persistCandidates]);

  // Export a single short
  const exportShort = useCallback(async (
    candidate: ShortCandidate,
    cropTo916: boolean
  ): Promise<ShortExport | null> => {
    if (!sessionId) return null;

    try {
      const response = await fetch(
        `${LOCAL_FFMPEG_URL}/session/${sessionId}/export-short`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            startTime: candidate.startTime,
            endTime: candidate.endTime,
            title: candidate.suggestedTitle,
            cropTo916,
          }),
        }
      );

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Export failed');
      }

      const result = await response.json();

      return {
        candidateId: candidate.id,
        filename: result.filename,
        downloadUrl: result.downloadUrl,
        status: 'complete',
      };
    } catch (err) {
      return {
        candidateId: candidate.id,
        filename: '',
        downloadUrl: '',
        status: 'error',
        error: err instanceof Error ? err.message : 'Export failed',
      };
    }
  }, [sessionId]);

  // Export all selected shorts
  const exportSelected = useCallback(async (cropTo916: boolean): Promise<ShortExport[]> => {
    const selected = candidates.filter(c => c.selected);
    if (selected.length === 0) {
      setError('No shorts selected');
      return [];
    }

    setExporting(true);
    setExportProgress({ current: 0, total: selected.length });
    setExports([]);

    const results: ShortExport[] = [];

    for (let i = 0; i < selected.length; i++) {
      const candidate = selected[i];
      setExportProgress({ current: i + 1, total: selected.length });

      // Add pending export
      setExports(prev => [...prev, {
        candidateId: candidate.id,
        filename: '',
        downloadUrl: '',
        status: 'rendering',
      }]);

      const result = await exportShort(candidate, cropTo916);
      if (result) {
        results.push(result);
        setExports(prev => prev.map(e =>
          e.candidateId === candidate.id ? result : e
        ));
      }
    }

    setExporting(false);
    setExportProgress(null);

    return results;
  }, [candidates, exportShort]);

  // Download a single export
  const downloadExport = useCallback(async (exp: ShortExport) => {
    if (exp.status !== 'complete' || !exp.downloadUrl) return;

    try {
      // Fetch as blob to ensure proper download without navigation
      const response = await fetch(`${LOCAL_FFMPEG_URL}${exp.downloadUrl}`);
      if (!response.ok) throw new Error('Download failed');

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = exp.filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      console.error('Download failed:', err);
    }
  }, []);

  // Download all completed exports
  const downloadAll = useCallback(() => {
    const completed = exports.filter(e => e.status === 'complete');
    completed.forEach(exp => {
      setTimeout(() => downloadExport(exp), 500);
    });
  }, [exports, downloadExport]);

  // Clear state
  const clear = useCallback(() => {
    setCandidates([]);
    setExports([]);
    setAnalyzedAssetId(null);
    setError(null);
    if (sessionId) {
      localStorage.removeItem(`${STORAGE_KEY}-${sessionId}`);
    }
  }, [sessionId]);

  return {
    candidates,
    exports,
    analyzing,
    exporting,
    exportProgress,
    error,
    analyzedAssetId,
    analyzeForShorts,
    toggleCandidate,
    selectAll,
    updateCandidate,
    exportSelected,
    downloadExport,
    downloadAll,
    clear,
    selectedCount: candidates.filter(c => c.selected).length,
  };
}
