import { useState, useCallback } from 'react';
import {
  Camera, Download, X, Sparkles,
  CheckCircle, Type, Palette, Copy, Check, Wand2
} from 'lucide-react';
import type { ThumbnailVariant, ThumbnailRequest, ThumbnailTextOverlay } from '@/react-app/hooks/useThumbnailGenerator';

interface ThumbnailGeneratorPanelProps {
  variants: ThumbnailVariant[];
  loading: boolean;
  error: string | null;
  selectedVariant: number;
  recommendedIndex: number;
  explanation: string;
  prompt?: string;  // AI-generated prompt for copy/paste
  onSetSelectedVariant: (index: number) => void;
  onGenerate: (request: ThumbnailRequest) => Promise<unknown>;
  onDownload: (index: number, resolution: '720p' | '1080p') => void;
  onClear: () => void;
  onClose: () => void;
}

const MODES = [
  { value: 'ai-generated', label: 'AI Creative', description: 'Generate eye-catching thumbnail from video theme' },
  { value: 'best-frame', label: 'Best Frame', description: 'AI picks the sharpest frame from video' },
  { value: 'variants', label: 'A/B Variants', description: 'Multiple frames to choose from' },
  { value: 'specific-time', label: 'Pick Time', description: 'Choose a specific timestamp' },
] as const;

const STYLES = [
  { value: 'youtube', label: 'YouTube', description: 'Vibrant, high saturation' },
  { value: 'dramatic', label: 'Dramatic', description: 'High contrast, cinematic' },
  { value: 'minimal', label: 'Minimal', description: 'Subtle enhancements' },
] as const;

export default function ThumbnailGeneratorPanel({
  variants,
  loading,
  error,
  selectedVariant,
  recommendedIndex,
  explanation,
  prompt,
  onSetSelectedVariant,
  onGenerate,
  onDownload,
  onClear,
  onClose,
}: ThumbnailGeneratorPanelProps) {
  const [mode, setMode] = useState<'ai-generated' | 'best-frame' | 'variants' | 'specific-time'>('ai-generated');
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [style, setStyle] = useState<'youtube' | 'dramatic' | 'minimal'>('youtube');
  const [timestamp, setTimestamp] = useState<number>(0);
  const [variantCount, setVariantCount] = useState<number>(3);
  const [showTextOverlay, setShowTextOverlay] = useState(false);
  const [textOverlay, setTextOverlay] = useState<ThumbnailTextOverlay>({
    text: '',
    position: 'bottom',
    fontSize: 'large',
    color: '#ffffff',
  });

  const handleGenerate = useCallback(async () => {
    const request: ThumbnailRequest = {
      mode,
      style,
      variantCount: mode === 'variants' ? variantCount : 1,
      timestamp: mode === 'specific-time' ? timestamp : undefined,
      textOverlay: showTextOverlay && textOverlay.text ? textOverlay : undefined,
    };
    await onGenerate(request);
  }, [mode, style, variantCount, timestamp, showTextOverlay, textOverlay, onGenerate]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[600px] max-h-[90vh] bg-zinc-900 rounded-xl border border-zinc-700 shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Camera className="w-5 h-5 text-orange-500" />
            <span className="font-medium text-white">AI Thumbnail Generator</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-zinc-500 hover:text-white rounded"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Mode Selection */}
          <div>
            <label className="text-xs text-zinc-400 mb-2 block">Mode</label>
            <div className="grid grid-cols-3 gap-2">
              {MODES.map((m) => (
                <button
                  key={m.value}
                  onClick={() => setMode(m.value)}
                  className={`p-2 rounded-lg border text-left transition-colors ${
                    mode === m.value
                      ? 'border-orange-500 bg-orange-500/10'
                      : 'border-zinc-700 hover:border-zinc-600'
                  }`}
                >
                  <div className="text-xs font-medium text-white">{m.label}</div>
                  <div className="text-[10px] text-zinc-500 mt-0.5">{m.description}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Mode-specific options */}
          {mode === 'specific-time' && (
            <div>
              <label className="text-xs text-zinc-400 mb-2 block">Timestamp (seconds)</label>
              <input
                type="number"
                value={timestamp}
                onChange={(e) => setTimestamp(parseFloat(e.target.value) || 0)}
                min={0}
                step={0.1}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm"
              />
            </div>
          )}

          {mode === 'variants' && (
            <div>
              <label className="text-xs text-zinc-400 mb-2 block">Number of Variants</label>
              <div className="flex items-center gap-3">
                {[2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    onClick={() => setVariantCount(n)}
                    className={`px-4 py-2 rounded-lg border transition-colors ${
                      variantCount === n
                        ? 'border-orange-500 bg-orange-500/10 text-white'
                        : 'border-zinc-700 text-zinc-400 hover:border-zinc-600'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Style Selection */}
          <div>
            <label className="text-xs text-zinc-400 mb-2 block">Style</label>
            <div className="grid grid-cols-3 gap-2">
              {STYLES.map((s) => (
                <button
                  key={s.value}
                  onClick={() => setStyle(s.value)}
                  className={`p-2 rounded-lg border text-left transition-colors ${
                    style === s.value
                      ? 'border-orange-500 bg-orange-500/10'
                      : 'border-zinc-700 hover:border-zinc-600'
                  }`}
                >
                  <div className="text-xs font-medium text-white">{s.label}</div>
                  <div className="text-[10px] text-zinc-500 mt-0.5">{s.description}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Text Overlay Toggle */}
          <div>
            <button
              onClick={() => setShowTextOverlay(!showTextOverlay)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors ${
                showTextOverlay
                  ? 'border-orange-500 bg-orange-500/10'
                  : 'border-zinc-700 hover:border-zinc-600'
              }`}
            >
              <Type className="w-4 h-4" />
              <span className="text-sm">Add Text Overlay</span>
            </button>
          </div>

          {/* Text Overlay Options */}
          {showTextOverlay && (
            <div className="p-3 bg-zinc-800/50 rounded-lg space-y-3">
              <input
                type="text"
                value={textOverlay.text}
                onChange={(e) => setTextOverlay({ ...textOverlay, text: e.target.value })}
                placeholder="Enter thumbnail text..."
                className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-sm"
              />
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <label className="text-[10px] text-zinc-500">Position</label>
                  <select
                    value={textOverlay.position}
                    onChange={(e) => setTextOverlay({ ...textOverlay, position: e.target.value as 'top' | 'center' | 'bottom' })}
                    className="w-full mt-1 px-2 py-1.5 bg-zinc-700 border border-zinc-600 rounded text-xs"
                  >
                    <option value="top">Top</option>
                    <option value="center">Center</option>
                    <option value="bottom">Bottom</option>
                  </select>
                </div>
                <div className="flex-1">
                  <label className="text-[10px] text-zinc-500">Size</label>
                  <select
                    value={textOverlay.fontSize}
                    onChange={(e) => setTextOverlay({ ...textOverlay, fontSize: e.target.value as 'small' | 'medium' | 'large' })}
                    className="w-full mt-1 px-2 py-1.5 bg-zinc-700 border border-zinc-600 rounded text-xs"
                  >
                    <option value="small">Small</option>
                    <option value="medium">Medium</option>
                    <option value="large">Large</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-zinc-500">Color</label>
                  <div className="flex items-center gap-2 mt-1">
                    <input
                      type="color"
                      value={textOverlay.color}
                      onChange={(e) => setTextOverlay({ ...textOverlay, color: e.target.value })}
                      className="w-8 h-8 rounded cursor-pointer border-0"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Error Display */}
          {error && (
            <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-xs text-red-300">
              {error}
            </div>
          )}

          {/* Loading State */}
          {loading && (
            <div className="text-center py-8">
              <div className="w-8 h-8 mx-auto mb-3 border-2 border-orange-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-zinc-400">Generating thumbnails...</p>
              <p className="text-xs text-zinc-500 mt-1">This may take a moment</p>
            </div>
          )}

          {/* Variants Grid */}
          {variants.length > 0 && !loading && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-zinc-400">
                  Generated Thumbnails ({variants.length})
                </label>
                {explanation && (
                  <span className="text-[10px] text-zinc-500">{explanation}</span>
                )}
              </div>

              {/* AI Prompt Copy Section */}
              {prompt && (
                <div className="mb-3 p-3 bg-zinc-800 rounded-lg border border-zinc-700">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Wand2 className="w-4 h-4 text-purple-400" />
                      <span className="text-xs text-zinc-400">AI Prompt (copy for other tools)</span>
                    </div>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(prompt);
                        setCopiedPrompt(true);
                        setTimeout(() => setCopiedPrompt(false), 2000);
                      }}
                      className="flex items-center gap-1 px-2 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors"
                    >
                      {copiedPrompt ? (
                        <>
                          <Check className="w-3 h-3 text-green-400" />
                          Copied!
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          Copy
                        </>
                      )}
                    </button>
                  </div>
                  <p className="text-xs text-zinc-300 leading-relaxed">{prompt}</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                {variants.map((variant, index) => (
                  <div
                    key={variant.assetId}
                    onClick={() => onSetSelectedVariant(index)}
                    className={`relative rounded-lg border-2 cursor-pointer overflow-hidden transition-colors ${
                      selectedVariant === index
                        ? 'border-orange-500'
                        : 'border-zinc-700 hover:border-zinc-600'
                    }`}
                  >
                    <img
                      src={`http://localhost:3333${variant.downloadUrl1080}`}
                      alt={variant.label}
                      className="w-full aspect-video object-cover"
                      crossOrigin="anonymous"
                    />
                    <div className="absolute top-2 left-2 flex items-center gap-1">
                      {index === recommendedIndex && (
                        <span className="px-1.5 py-0.5 bg-green-500 rounded text-[10px] font-medium">
                          Recommended
                        </span>
                      )}
                    </div>
                    <div className="absolute bottom-0 inset-x-0 p-2 bg-gradient-to-t from-black/80 to-transparent">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-white">{variant.label}</span>
                        <span className="text-[10px] text-zinc-400">
                          {variant.timestamp.toFixed(1)}s
                        </span>
                      </div>
                    </div>
                    {selectedVariant === index && (
                      <div className="absolute top-2 right-2">
                        <CheckCircle className="w-5 h-5 text-orange-500" />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="p-4 border-t border-zinc-800 space-y-2">
          {variants.length === 0 ? (
            <button
              onClick={handleGenerate}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 rounded-lg font-medium transition-colors"
            >
              <Sparkles className="w-4 h-4" />
              Generate Thumbnail{mode === 'variants' ? 's' : ''}
            </button>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => onDownload(selectedVariant, '1080p')}
                  className="flex items-center justify-center gap-2 px-4 py-2 bg-orange-500 hover:bg-orange-600 rounded-lg text-sm font-medium transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Download 1080p
                </button>
                <button
                  onClick={() => onDownload(selectedVariant, '720p')}
                  className="flex items-center justify-center gap-2 px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded-lg text-sm transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Download 720p
                </button>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleGenerate}
                  disabled={loading}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs transition-colors"
                >
                  <Sparkles className="w-3 h-3" />
                  Regenerate
                </button>
                <button
                  onClick={onClear}
                  className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs transition-colors"
                >
                  Clear
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
