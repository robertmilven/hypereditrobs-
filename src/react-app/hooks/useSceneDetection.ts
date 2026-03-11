import { useState, useCallback, useEffect } from 'react';
import type { DetectedScene } from './useProject';

const LOCAL_FFMPEG_URL = 'http://localhost:3333';
const STORAGE_KEY = 'clipwise-detected-scenes';

export interface SceneDetectionResult {
  scenes: DetectedScene[];
  totalDuration: number;
  analyzedAssetId: string;
  detectedAt: number;
}

export function useSceneDetection(sessionId: string | undefined) {
  const [scenes, setScenes] = useState<DetectedScene[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analyzedAssetId, setAnalyzedAssetId] = useState<string | null>(null);

  // Load cached scenes from localStorage
  useEffect(() => {
    if (!sessionId) return;
    try {
      const stored = localStorage.getItem(`${STORAGE_KEY}-${sessionId}`);
      if (stored) {
        const data: SceneDetectionResult = JSON.parse(stored);
        setScenes(data.scenes.map(s => ({ ...s, selected: true })));
        setAnalyzedAssetId(data.analyzedAssetId);
        console.log('[useSceneDetection] Loaded cached scenes:', data.scenes.length);
      }
    } catch {
      // Ignore parse errors
    }
  }, [sessionId]);

  // Persist scenes to localStorage
  const persistScenes = useCallback((newScenes: DetectedScene[], assetId: string) => {
    if (!sessionId) return;
    const result: SceneDetectionResult = {
      scenes: newScenes,
      totalDuration: newScenes.reduce((sum, s) => Math.max(sum, s.endTime), 0),
      analyzedAssetId: assetId,
      detectedAt: Date.now(),
    };
    localStorage.setItem(`${STORAGE_KEY}-${sessionId}`, JSON.stringify(result));
  }, [sessionId]);

  // Run scene detection
  const detectScenes = useCallback(async (
    assetId?: string,
    includeVisualDetection = true
  ): Promise<DetectedScene[]> => {
    if (!sessionId) throw new Error('No session');

    setLoading(true);
    setError(null);

    try {
      console.log('[useSceneDetection] Starting scene detection...');
      const response = await fetch(
        `${LOCAL_FFMPEG_URL}/session/${sessionId}/analyze-scenes`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assetId, includeVisualDetection }),
        }
      );

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Scene detection failed');
      }

      const result = await response.json();
      console.log('[useSceneDetection] Received scenes:', result.scenes?.length);

      const detectedScenes: DetectedScene[] = (result.scenes || []).map((s: DetectedScene) => ({
        ...s,
        thumbnailUrl: s.thumbnailUrl
          ? `${LOCAL_FFMPEG_URL}${s.thumbnailUrl}`
          : undefined,
        selected: true,
      }));

      setScenes(detectedScenes);
      setAnalyzedAssetId(result.analyzedAssetId);
      persistScenes(detectedScenes, result.analyzedAssetId);

      return detectedScenes;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Detection failed';
      setError(message);
      console.error('[useSceneDetection] Error:', message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [sessionId, persistScenes]);

  // Toggle scene selection
  const toggleSceneSelection = useCallback((sceneId: string) => {
    setScenes(prev => {
      const updated = prev.map(s =>
        s.id === sceneId ? { ...s, selected: !s.selected } : s
      );
      if (analyzedAssetId) persistScenes(updated, analyzedAssetId);
      return updated;
    });
  }, [analyzedAssetId, persistScenes]);

  // Select/deselect all
  const selectAll = useCallback((selected: boolean) => {
    setScenes(prev => {
      const updated = prev.map(s => ({ ...s, selected }));
      if (analyzedAssetId) persistScenes(updated, analyzedAssetId);
      return updated;
    });
  }, [analyzedAssetId, persistScenes]);

  // Update scene boundary
  const updateSceneBoundary = useCallback((
    sceneId: string,
    updates: { startTime?: number; endTime?: number; title?: string }
  ) => {
    setScenes(prev => {
      const updated = prev.map(s => {
        if (s.id !== sceneId) return s;
        const newScene = { ...s, ...updates };
        if (updates.startTime !== undefined || updates.endTime !== undefined) {
          newScene.duration = newScene.endTime - newScene.startTime;
        }
        return newScene;
      });
      if (analyzedAssetId) persistScenes(updated, analyzedAssetId);
      return updated;
    });
  }, [analyzedAssetId, persistScenes]);

  // Merge two adjacent scenes
  const mergeScenes = useCallback((sceneId1: string, sceneId2: string) => {
    setScenes(prev => {
      const idx1 = prev.findIndex(s => s.id === sceneId1);
      const idx2 = prev.findIndex(s => s.id === sceneId2);
      if (idx1 < 0 || idx2 < 0) return prev;

      const [first, second] = idx1 < idx2
        ? [prev[idx1], prev[idx2]]
        : [prev[idx2], prev[idx1]];

      const merged: DetectedScene = {
        id: `merged-${Date.now()}`,
        title: first.title,
        startTime: first.startTime,
        endTime: second.endTime,
        duration: second.endTime - first.startTime,
        thumbnailUrl: first.thumbnailUrl,
        confidence: Math.min(first.confidence, second.confidence),
        isVisualBreak: first.isVisualBreak || second.isVisualBreak,
        selected: first.selected || second.selected,
      };

      const updated = prev.filter(s => s.id !== sceneId1 && s.id !== sceneId2);
      updated.splice(Math.min(idx1, idx2), 0, merged);

      if (analyzedAssetId) persistScenes(updated, analyzedAssetId);
      return updated;
    });
  }, [analyzedAssetId, persistScenes]);

  // Split scene at timestamp
  const splitScene = useCallback((sceneId: string, splitTime: number) => {
    setScenes(prev => {
      const idx = prev.findIndex(s => s.id === sceneId);
      if (idx < 0) return prev;

      const scene = prev[idx];
      if (splitTime <= scene.startTime || splitTime >= scene.endTime) return prev;

      const scene1: DetectedScene = {
        ...scene,
        id: `${scene.id}-a`,
        endTime: splitTime,
        duration: splitTime - scene.startTime,
      };

      const scene2: DetectedScene = {
        ...scene,
        id: `${scene.id}-b`,
        title: `${scene.title} (cont.)`,
        startTime: splitTime,
        duration: scene.endTime - splitTime,
        thumbnailUrl: undefined, // Would need to regenerate
      };

      const updated = [...prev];
      updated.splice(idx, 1, scene1, scene2);

      if (analyzedAssetId) persistScenes(updated, analyzedAssetId);
      return updated;
    });
  }, [analyzedAssetId, persistScenes]);

  // Clear all scenes
  const clearScenes = useCallback(() => {
    setScenes([]);
    setAnalyzedAssetId(null);
    if (sessionId) {
      localStorage.removeItem(`${STORAGE_KEY}-${sessionId}`);
    }
  }, [sessionId]);

  return {
    scenes,
    loading,
    error,
    analyzedAssetId,
    detectScenes,
    toggleSceneSelection,
    selectAll,
    updateSceneBoundary,
    mergeScenes,
    splitScene,
    clearScenes,
    selectedScenes: scenes.filter(s => s.selected),
  };
}
