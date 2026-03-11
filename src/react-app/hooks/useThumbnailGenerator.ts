import { useState, useCallback } from 'react';

const LOCAL_FFMPEG_URL = 'http://localhost:3333';

export interface ThumbnailTextOverlay {
  text: string;
  position: 'top' | 'center' | 'bottom';
  fontSize: 'small' | 'medium' | 'large';
  color: string;
}

export interface ThumbnailRequest {
  mode: 'best-frame' | 'specific-time' | 'variants';
  timestamp?: number;
  style: 'youtube' | 'dramatic' | 'minimal';
  textOverlay?: ThumbnailTextOverlay;
  variantCount?: number;
  assetId?: string;
}

export interface ThumbnailVariant {
  assetId: string;
  thumbnailUrl: string;
  downloadUrl1080: string;
  downloadUrl720: string;
  label: string;
  timestamp: number;
  style: string;
  score: number;
  prompt?: string;  // AI-generated prompt for copy/paste
}

export interface ThumbnailGenerationResult {
  variants: ThumbnailVariant[];
  recommendedIndex: number;
  explanation: string;
  prompt?: string;  // Overall AI prompt for copy/paste
}

export function useThumbnailGenerator(sessionId: string | undefined) {
  const [variants, setVariants] = useState<ThumbnailVariant[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedVariant, setSelectedVariant] = useState<number>(0);
  const [recommendedIndex, setRecommendedIndex] = useState<number>(0);
  const [explanation, setExplanation] = useState<string>('');
  const [prompt, setPrompt] = useState<string>('');

  const generate = useCallback(async (request: ThumbnailRequest): Promise<ThumbnailGenerationResult | null> => {
    if (!sessionId) {
      setError('No active session');
      return null;
    }

    setLoading(true);
    setError(null);

    try {
      console.log('[useThumbnailGenerator] Generating thumbnails...', request);

      const response = await fetch(
        `${LOCAL_FFMPEG_URL}/session/${sessionId}/generate-youtube-thumbnail`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }
      );

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Thumbnail generation failed');
      }

      const result: ThumbnailGenerationResult = await response.json();
      console.log('[useThumbnailGenerator] Generated:', result.variants.length, 'variants');

      setVariants(result.variants);
      setRecommendedIndex(result.recommendedIndex);
      setSelectedVariant(result.recommendedIndex);
      setExplanation(result.explanation);
      setPrompt(result.prompt || '');

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Generation failed';
      setError(message);
      console.error('[useThumbnailGenerator] Error:', message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  const downloadVariant = useCallback(async (index: number, resolution: '720p' | '1080p') => {
    const variant = variants[index];
    if (!variant) return;

    const url = resolution === '1080p'
      ? `${LOCAL_FFMPEG_URL}${variant.downloadUrl1080}`
      : `${LOCAL_FFMPEG_URL}${variant.downloadUrl720}`;

    try {
      // Fetch the image as a blob to ensure proper download
      const response = await fetch(url);
      if (!response.ok) throw new Error('Download failed');

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `thumbnail_${resolution}_${variant.label.replace(/\s+/g, '_')}.jpg`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // Clean up the blob URL
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      console.error('Download failed:', err);
    }
  }, [variants]);

  const clearVariants = useCallback(() => {
    setVariants([]);
    setSelectedVariant(0);
    setRecommendedIndex(0);
    setExplanation('');
    setPrompt('');
    setError(null);
  }, []);

  return {
    variants,
    loading,
    error,
    selectedVariant,
    setSelectedVariant,
    recommendedIndex,
    explanation,
    prompt,
    generate,
    downloadVariant,
    clearVariants,
  };
}
