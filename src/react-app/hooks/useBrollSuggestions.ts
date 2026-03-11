import { useState, useCallback } from 'react';

const LOCAL_FFMPEG_URL = 'http://localhost:3333';
const STORAGE_KEY = 'clipwise-broll-suggestions';

export interface BrollSource {
  type: 'pexels' | 'unsplash' | 'ai-generated';
  thumbnailUrl: string | null;
  fullUrl: string | null;
  attribution?: string;
  prompt?: string;
}

export interface BrollSuggestion {
  id: string;
  keyword: string;
  timestamp: number;
  reason: string;
  prompt: string;
  sources: BrollSource[];
  applied?: boolean;
  appliedAssetId?: string;
}

export function useBrollSuggestions(sessionId: string | undefined) {
  const [suggestions, setSuggestions] = useState<BrollSuggestion[]>(() => {
    if (!sessionId) return [];
    try {
      const stored = localStorage.getItem(`${STORAGE_KEY}-${sessionId}`);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch {}
    return [];
  });
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analyzedAssetId, setAnalyzedAssetId] = useState<string | null>(null);

  // Persist to localStorage
  const persistSuggestions = useCallback((newSuggestions: BrollSuggestion[]) => {
    if (!sessionId) return;
    localStorage.setItem(`${STORAGE_KEY}-${sessionId}`, JSON.stringify(newSuggestions));
  }, [sessionId]);

  // Fetch B-roll suggestions
  const fetchSuggestions = useCallback(async (
    options?: { includePexels?: boolean; includeUnsplash?: boolean; includeAI?: boolean }
  ): Promise<BrollSuggestion[]> => {
    if (!sessionId) {
      setError('No active session');
      return [];
    }

    setLoading(true);
    setError(null);

    try {
      console.log('[useBrollSuggestions] Fetching suggestions...');

      const response = await fetch(
        `${LOCAL_FFMPEG_URL}/session/${sessionId}/suggest-broll`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            includePexels: options?.includePexels ?? true,
            includeUnsplash: options?.includeUnsplash ?? true,
            includeAI: options?.includeAI ?? true,
          }),
        }
      );

      if (!response.ok) {
        const err = await response.json();
        // If analysis is already in progress, don't show as error
        if (err.inProgress) {
          console.log('[useBrollSuggestions] Analysis already in progress');
          return suggestions; // Return current suggestions
        }
        throw new Error(err.error || 'Failed to get suggestions');
      }

      const result = await response.json();
      console.log('[useBrollSuggestions] Received:', result.suggestions?.length, 'suggestions');

      const newSuggestions = result.suggestions || [];
      setSuggestions(newSuggestions);
      setAnalyzedAssetId(result.analyzedAssetId);
      persistSuggestions(newSuggestions);

      return newSuggestions;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get suggestions';
      setError(message);
      console.error('[useBrollSuggestions] Error:', message);
      return [];
    } finally {
      setLoading(false);
    }
  }, [sessionId, persistSuggestions]);

  // Apply a suggestion (download/generate and register asset)
  const applySuggestion = useCallback(async (
    suggestionId: string,
    sourceType: BrollSource['type'],
    source?: BrollSource
  ): Promise<{ assetId: string; timestamp: number; duration: number } | null> => {
    if (!sessionId) {
      setError('No active session');
      return null;
    }

    const suggestion = suggestions.find(s => s.id === suggestionId);
    if (!suggestion) {
      setError('Suggestion not found');
      return null;
    }

    setApplying(suggestionId);
    setError(null);

    try {
      console.log('[useBrollSuggestions] Applying suggestion:', suggestionId, sourceType);

      const response = await fetch(
        `${LOCAL_FFMPEG_URL}/session/${sessionId}/apply-broll`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            suggestionId,
            sourceType,
            sourceUrl: source?.fullUrl,
            prompt: source?.prompt || suggestion.prompt,
            timestamp: suggestion.timestamp,
            keyword: suggestion.keyword,
          }),
        }
      );

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to apply suggestion');
      }

      const result = await response.json();
      console.log('[useBrollSuggestions] Applied:', result.assetId);

      // Update suggestion as applied
      setSuggestions(prev => {
        const updated = prev.map(s =>
          s.id === suggestionId
            ? { ...s, applied: true, appliedAssetId: result.assetId }
            : s
        );
        persistSuggestions(updated);
        return updated;
      });

      return {
        assetId: result.assetId,
        timestamp: result.timestamp,
        duration: result.duration,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to apply suggestion';
      setError(message);
      console.error('[useBrollSuggestions] Error:', message);
      return null;
    } finally {
      setApplying(null);
    }
  }, [sessionId, suggestions, persistSuggestions]);

  // Clear suggestions
  const clearSuggestions = useCallback(() => {
    setSuggestions([]);
    setAnalyzedAssetId(null);
    if (sessionId) {
      localStorage.removeItem(`${STORAGE_KEY}-${sessionId}`);
    }
  }, [sessionId]);

  return {
    suggestions,
    loading,
    applying,
    error,
    analyzedAssetId,
    fetchSuggestions,
    applySuggestion,
    clear: clearSuggestions,  // Alias for Home.tsx compatibility
    clearSuggestions,
  };
}
