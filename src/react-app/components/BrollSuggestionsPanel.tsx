import { useState, useCallback } from 'react';
import {
  Image, X, Sparkles, Check, Clock,
  ExternalLink, Wand2, Camera
} from 'lucide-react';
import type { BrollSuggestion, BrollSource } from '@/react-app/hooks/useBrollSuggestions';

interface BrollSuggestionsPanelProps {
  suggestions: BrollSuggestion[];
  loading: boolean;
  applying: string | null;
  error: string | null;
  onFetchSuggestions: () => Promise<BrollSuggestion[]>;
  onApplySuggestion: (
    suggestionId: string,
    sourceType: BrollSource['type'],
    source?: BrollSource
  ) => Promise<{ assetId: string; timestamp: number; duration: number } | null>;
  onClear: () => void;
  onClose: () => void;
  onAddToTimeline?: (assetId: string, timestamp: number, duration: number) => void;
}

// Format seconds to MM:SS
function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export default function BrollSuggestionsPanel({
  suggestions,
  loading,
  applying,
  error,
  onFetchSuggestions,
  onApplySuggestion,
  onClear,
  onClose,
  onAddToTimeline,
}: BrollSuggestionsPanelProps) {
  const [expandedSuggestion, setExpandedSuggestion] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<Record<string, { type: BrollSource['type']; source?: BrollSource }>>({});

  const handleApply = useCallback(async (suggestion: BrollSuggestion) => {
    const selected = selectedSource[suggestion.id];
    if (!selected) {
      // Default to first available source
      const firstSource = suggestion.sources[0];
      if (!firstSource) return;

      const result = await onApplySuggestion(suggestion.id, firstSource.type, firstSource);
      if (result && onAddToTimeline) {
        onAddToTimeline(result.assetId, result.timestamp, result.duration);
      }
    } else {
      const result = await onApplySuggestion(suggestion.id, selected.type, selected.source);
      if (result && onAddToTimeline) {
        onAddToTimeline(result.assetId, result.timestamp, result.duration);
      }
    }
  }, [selectedSource, onApplySuggestion, onAddToTimeline]);

  const getSourceIcon = (type: BrollSource['type']) => {
    switch (type) {
      case 'pexels':
      case 'unsplash':
        return <Camera className="w-3 h-3" />;
      case 'ai-generated':
        return <Wand2 className="w-3 h-3" />;
    }
  };

  const getSourceLabel = (type: BrollSource['type']) => {
    switch (type) {
      case 'pexels': return 'Pexels';
      case 'unsplash': return 'Unsplash';
      case 'ai-generated': return 'AI Generate';
    }
  };

  return (
    <div className="flex flex-col h-full bg-zinc-900 border-l border-zinc-800">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/50">
        <div className="flex items-center gap-2">
          <Image className="w-4 h-4 text-blue-500" />
          <span className="text-sm font-medium text-white">B-Roll Suggestions</span>
        </div>
        <div className="flex items-center gap-2">
          {suggestions.length > 0 && (
            <span className="text-[10px] text-zinc-500">
              {suggestions.filter(s => s.applied).length}/{suggestions.length} applied
            </span>
          )}
          <button
            onClick={onClose}
            className="p-1 text-zinc-500 hover:text-white rounded"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Empty State */}
        {suggestions.length === 0 && !loading && (
          <div className="text-center py-8">
            <Image className="w-12 h-12 mx-auto text-zinc-600 mb-3" />
            <p className="text-sm text-zinc-400 mb-2">
              AI B-Roll Suggestions
            </p>
            <p className="text-xs text-zinc-500 mb-4 px-4">
              Analyze your video transcript to find perfect moments for visual overlays
            </p>
            <button
              onClick={() => onFetchSuggestions()}
              disabled={loading}
              className="flex items-center gap-2 mx-auto px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
            >
              <Sparkles className="w-4 h-4" />
              Find B-Roll Moments
            </button>
          </div>
        )}

        {/* Loading State */}
        {loading && (
          <div className="text-center py-8">
            <div className="w-8 h-8 mx-auto mb-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-zinc-400">Analyzing transcript...</p>
            <p className="text-xs text-zinc-500 mt-1">Finding visual opportunities</p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-xs text-red-300">
            {error}
          </div>
        )}

        {/* Suggestions List */}
        {suggestions.length > 0 && !loading && (
          <>
            {/* Controls */}
            <div className="flex items-center gap-2 text-[10px]">
              <button
                onClick={() => onFetchSuggestions()}
                className="text-zinc-400 hover:text-white"
              >
                Refresh
              </button>
              <span className="text-zinc-600">|</span>
              <button
                onClick={onClear}
                className="text-red-400 hover:text-red-300"
              >
                Clear
              </button>
            </div>

            {/* Suggestion Cards */}
            <div className="space-y-2">
              {suggestions.map((suggestion) => (
                <div
                  key={suggestion.id}
                  className={`rounded-lg border transition-colors ${
                    suggestion.applied
                      ? 'border-green-500/50 bg-green-500/10'
                      : 'border-zinc-700 bg-zinc-800'
                  }`}
                >
                  <div className="p-3">
                    {/* Header */}
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-white">
                            {suggestion.keyword}
                          </span>
                          {suggestion.applied && (
                            <Check className="w-4 h-4 text-green-500" />
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <Clock className="w-3 h-3 text-zinc-500" />
                          <span className="text-[10px] text-zinc-500">
                            {formatTime(suggestion.timestamp)}
                          </span>
                          <span className="text-[10px] text-zinc-600">•</span>
                          <span className="text-[10px] text-zinc-500">
                            {suggestion.reason}
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={() => setExpandedSuggestion(
                          expandedSuggestion === suggestion.id ? null : suggestion.id
                        )}
                        className="text-xs text-zinc-500 hover:text-white"
                      >
                        {expandedSuggestion === suggestion.id ? 'Less' : 'More'}
                      </button>
                    </div>

                    {/* Expanded: Source Selection */}
                    {expandedSuggestion === suggestion.id && (
                      <div className="mt-3 pt-3 border-t border-zinc-700">
                        <label className="text-[10px] text-zinc-500 mb-2 block">
                          Choose source:
                        </label>
                        <div className="grid grid-cols-3 gap-2 mb-3">
                          {suggestion.sources.map((source, idx) => (
                            <button
                              key={`${source.type}-${idx}`}
                              onClick={() => setSelectedSource(prev => ({
                                ...prev,
                                [suggestion.id]: { type: source.type, source }
                              }))}
                              className={`relative rounded overflow-hidden border-2 transition-colors ${
                                selectedSource[suggestion.id]?.type === source.type &&
                                selectedSource[suggestion.id]?.source === source
                                  ? 'border-blue-500'
                                  : 'border-zinc-600 hover:border-zinc-500'
                              }`}
                            >
                              {source.thumbnailUrl ? (
                                <img
                                  src={source.thumbnailUrl}
                                  alt={source.type}
                                  className="w-full aspect-square object-cover"
                                  crossOrigin="anonymous"
                                />
                              ) : (
                                <div className="w-full aspect-square bg-gradient-to-br from-purple-500/20 to-blue-500/20 flex items-center justify-center">
                                  <Wand2 className="w-6 h-6 text-purple-400" />
                                </div>
                              )}
                              <div className="absolute bottom-0 inset-x-0 bg-black/70 px-1 py-0.5">
                                <div className="flex items-center justify-center gap-1">
                                  {getSourceIcon(source.type)}
                                  <span className="text-[9px] text-white">
                                    {getSourceLabel(source.type)}
                                  </span>
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>

                        {/* AI Prompt Preview */}
                        {selectedSource[suggestion.id]?.type === 'ai-generated' && (
                          <div className="mb-3 p-2 bg-zinc-700/50 rounded text-[10px] text-zinc-400">
                            <span className="text-zinc-500">Prompt:</span> {suggestion.prompt}
                          </div>
                        )}

                        {/* Attribution */}
                        {selectedSource[suggestion.id]?.source?.attribution && (
                          <div className="mb-3 flex items-center gap-1 text-[10px] text-zinc-500">
                            <ExternalLink className="w-3 h-3" />
                            {selectedSource[suggestion.id]?.source?.attribution}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Apply Button */}
                    {!suggestion.applied && (
                      <button
                        onClick={() => handleApply(suggestion)}
                        disabled={applying === suggestion.id}
                        className="w-full mt-2 flex items-center justify-center gap-2 px-3 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 rounded text-xs font-medium transition-colors"
                      >
                        {applying === suggestion.id ? (
                          <>
                            <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                            Applying...
                          </>
                        ) : (
                          <>
                            <Image className="w-3 h-3" />
                            Apply to Timeline
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Bottom Actions */}
      {suggestions.length > 0 && !loading && (
        <div className="p-3 border-t border-zinc-800/50">
          <button
            onClick={() => onFetchSuggestions()}
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs text-zinc-400 transition-colors"
          >
            <Sparkles className="w-3 h-3" />
            Re-analyze
          </button>
        </div>
      )}
    </div>
  );
}
