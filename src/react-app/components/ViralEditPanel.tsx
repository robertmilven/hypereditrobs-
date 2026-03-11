import { useState, useCallback } from 'react';
import {
  Zap, X, Sparkles, ZoomIn, Type, FastForward,
  Scissors, AlertTriangle, Check, Clock
} from 'lucide-react';
import type {
  EmphasisPoint,
  SlowSection,
  ViralEditConfig,
  ViralEditProgress,
  ViralEditResult
} from '@/react-app/hooks/useViralEdit';

interface ViralEditPanelProps {
  processing: boolean;
  progress: ViralEditProgress | null;
  error: string | null;
  emphasisPoints: EmphasisPoint[];
  slowSections: SlowSection[];
  result: ViralEditResult | null;
  hasCaptions: boolean;  // Whether caption clips exist on the timeline
  onApplyViralEdits: (
    config: ViralEditConfig,
    callbacks?: {
      onApplyZoomCut?: (timestamp: number, scale: number) => void;
      onUpdateCaptionStyle?: (style: { animation: string; highlightColor: string }) => void;
    }
  ) => Promise<ViralEditResult | null>;
  onClear: () => void;
  onClose: () => void;
  // Callbacks to actually apply edits in the editor
  onApplyZoomCut?: (timestamp: number, scale: number) => void;
  onUpdateCaptionStyle?: (style: { animation: string; highlightColor: string }) => void;
}

// Format seconds to MM:SS
function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export default function ViralEditPanel({
  processing,
  progress,
  error,
  emphasisPoints,
  slowSections,
  result,
  hasCaptions,
  onApplyViralEdits,
  onClear,
  onClose,
  onApplyZoomCut,
  onUpdateCaptionStyle,
}: ViralEditPanelProps) {
  const [config, setConfig] = useState<ViralEditConfig>({
    enableZoomCuts: true,
    enableKaraokeCaptions: true,
    enableSpeedBoost: false,
    zoomIntensity: 1.2,
    detectSlowSections: true,
  });

  const handleApply = useCallback(async () => {
    await onApplyViralEdits(config, {
      onApplyZoomCut,
      onUpdateCaptionStyle,
    });
  }, [config, onApplyViralEdits, onApplyZoomCut, onUpdateCaptionStyle]);

  const getEmphasisTypeColor = (type: EmphasisPoint['type']) => {
    switch (type) {
      case 'punchline': return 'bg-yellow-500/20 text-yellow-400';
      case 'emotional': return 'bg-pink-500/20 text-pink-400';
      case 'exclamation': return 'bg-red-500/20 text-red-400';
      case 'pause': return 'bg-blue-500/20 text-blue-400';
      default: return 'bg-purple-500/20 text-purple-400';
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[550px] max-h-[90vh] bg-zinc-900 rounded-xl border border-zinc-700 shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 bg-gradient-to-r from-pink-500/10 to-purple-500/10">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-pink-500" />
            <span className="font-medium text-white">Make it Viral</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-zinc-500 hover:text-white rounded"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Introduction */}
          {!result && !processing && (
            <div className="text-center py-4">
              <div className="w-16 h-16 mx-auto mb-3 rounded-full bg-gradient-to-br from-pink-500/20 to-purple-500/20 flex items-center justify-center">
                <Sparkles className="w-8 h-8 text-pink-400" />
              </div>
              <h3 className="text-lg font-medium text-white mb-1">
                One-Click Viral Edits
              </h3>
              <p className="text-sm text-zinc-400 max-w-sm mx-auto">
                Apply trending edit patterns used by top creators to make your content more engaging
              </p>
            </div>
          )}

          {/* Config Options */}
          {!processing && !result && (
            <div className="space-y-3">
              <label className="text-xs text-zinc-400 uppercase tracking-wide">
                Edit Features
              </label>

              {/* Zoom Cuts */}
              <div
                onClick={() => setConfig(c => ({ ...c, enableZoomCuts: !c.enableZoomCuts }))}
                className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                  config.enableZoomCuts
                    ? 'border-pink-500 bg-pink-500/10'
                    : 'border-zinc-700 hover:border-zinc-600'
                }`}
              >
                <div className="flex items-center gap-3">
                  <ZoomIn className={`w-5 h-5 ${config.enableZoomCuts ? 'text-pink-400' : 'text-zinc-500'}`} />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-white">Zoom Cuts</div>
                    <div className="text-xs text-zinc-500">Auto-zoom on emphasized words</div>
                  </div>
                  <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${
                    config.enableZoomCuts ? 'border-pink-500 bg-pink-500' : 'border-zinc-600'
                  }`}>
                    {config.enableZoomCuts && <Check className="w-3 h-3 text-white" />}
                  </div>
                </div>

                {config.enableZoomCuts && (
                  <div className="mt-3 pt-3 border-t border-zinc-700">
                    <label className="text-[10px] text-zinc-500">Zoom Intensity</label>
                    <div className="flex items-center gap-3 mt-1">
                      <input
                        type="range"
                        min={1.1}
                        max={1.5}
                        step={0.05}
                        value={config.zoomIntensity}
                        onChange={(e) => setConfig(c => ({ ...c, zoomIntensity: parseFloat(e.target.value) }))}
                        onClick={(e) => e.stopPropagation()}
                        className="flex-1"
                      />
                      <span className="text-xs text-zinc-400 w-10">
                        {config.zoomIntensity.toFixed(2)}x
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* Karaoke Captions */}
              <div
                onClick={() => setConfig(c => ({ ...c, enableKaraokeCaptions: !c.enableKaraokeCaptions }))}
                className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                  config.enableKaraokeCaptions
                    ? 'border-purple-500 bg-purple-500/10'
                    : 'border-zinc-700 hover:border-zinc-600'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Type className={`w-5 h-5 ${config.enableKaraokeCaptions ? 'text-purple-400' : 'text-zinc-500'}`} />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-white">Karaoke Captions</div>
                    <div className="text-xs text-zinc-500">Highlight words as they're spoken</div>
                  </div>
                  <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${
                    config.enableKaraokeCaptions ? 'border-purple-500 bg-purple-500' : 'border-zinc-600'
                  }`}>
                    {config.enableKaraokeCaptions && <Check className="w-3 h-3 text-white" />}
                  </div>
                </div>
              </div>

              {/* Warning: No captions */}
              {config.enableKaraokeCaptions && !hasCaptions && (
                <div className="p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-yellow-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="text-sm font-medium text-yellow-400">No captions found</div>
                    <div className="text-xs text-zinc-400 mt-0.5">
                      Karaoke captions require caption clips on the timeline. Generate captions first using the caption tool, then come back here.
                    </div>
                  </div>
                </div>
              )}

              {/* Detect Slow Sections */}
              <div
                onClick={() => setConfig(c => ({ ...c, detectSlowSections: !c.detectSlowSections }))}
                className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                  config.detectSlowSections
                    ? 'border-orange-500 bg-orange-500/10'
                    : 'border-zinc-700 hover:border-zinc-600'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Scissors className={`w-5 h-5 ${config.detectSlowSections ? 'text-orange-400' : 'text-zinc-500'}`} />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-white">Find Slow Sections</div>
                    <div className="text-xs text-zinc-500">Identify boring parts to cut</div>
                  </div>
                  <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${
                    config.detectSlowSections ? 'border-orange-500 bg-orange-500' : 'border-zinc-600'
                  }`}>
                    {config.detectSlowSections && <Check className="w-3 h-3 text-white" />}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Processing State */}
          {processing && progress && (
            <div className="text-center py-8">
              <div className="w-16 h-16 mx-auto mb-4 relative">
                <div className="absolute inset-0 rounded-full border-4 border-zinc-700" />
                <div
                  className="absolute inset-0 rounded-full border-4 border-pink-500 border-t-transparent animate-spin"
                />
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-sm font-medium text-white">{progress.percent}%</span>
                </div>
              </div>
              <p className="text-sm text-zinc-400">{progress.step}</p>
            </div>
          )}

          {/* Results */}
          {result && !processing && (
            <div className="space-y-4">
              {/* Summary */}
              <div className="p-4 rounded-lg bg-gradient-to-br from-pink-500/10 to-purple-500/10 border border-pink-500/30">
                <div className="flex items-center gap-2 mb-2">
                  <Check className="w-5 h-5 text-green-500" />
                  <span className="font-medium text-white">Viral Edits Applied!</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="flex items-center gap-2">
                    <ZoomIn className="w-3 h-3 text-pink-400" />
                    <span className="text-zinc-400">{result.zoomCutsApplied} zoom cuts</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Type className="w-3 h-3 text-purple-400" />
                    <span className="text-zinc-400">
                      {result.captionStyleUpdated ? 'Captions updated' : 'No caption changes'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Emphasis Points Found */}
              {emphasisPoints.length > 0 && (
                <div>
                  <label className="text-xs text-zinc-400 mb-2 block">
                    Key Moments ({emphasisPoints.length})
                  </label>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {emphasisPoints.map((point, idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-2 p-2 bg-zinc-800 rounded text-xs"
                      >
                        <Clock className="w-3 h-3 text-zinc-500" />
                        <span className="text-zinc-400">{formatTime(point.timestamp)}</span>
                        <span className="font-medium text-white">"{point.word}"</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] ${getEmphasisTypeColor(point.type)}`}>
                          {point.type}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Slow Sections */}
              {slowSections.length > 0 && (
                <div>
                  <label className="text-xs text-zinc-400 mb-2 block flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3 text-orange-500" />
                    Slow Sections ({slowSections.length})
                  </label>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {slowSections.map((section, idx) => (
                      <div
                        key={idx}
                        className="p-2 bg-orange-500/10 border border-orange-500/30 rounded text-xs"
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-zinc-400">
                            {formatTime(section.startTime)} - {formatTime(section.endTime)}
                          </span>
                          <span className="text-orange-400">{section.suggestion}</span>
                        </div>
                        <div className="text-zinc-500">{section.reason}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-xs text-red-300">
              {error}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="p-4 border-t border-zinc-800">
          {!result ? (
            <button
              onClick={handleApply}
              disabled={processing || (!config.enableZoomCuts && !config.enableKaraokeCaptions && !config.detectSlowSections)}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-gradient-to-r from-pink-500 to-purple-500 hover:from-pink-600 hover:to-purple-600 disabled:opacity-50 rounded-lg font-medium transition-colors"
            >
              <Zap className="w-5 h-5" />
              Make it Viral
            </button>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={handleApply}
                disabled={processing}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded-lg text-sm transition-colors"
              >
                <Sparkles className="w-4 h-4" />
                Re-apply
              </button>
              <button
                onClick={onClear}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm transition-colors"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
