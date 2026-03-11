import { useState, useCallback } from 'react';
import {
  Scissors, X, Sparkles, Download, Check,
  Square, CheckSquare, Clock, TrendingUp, Edit3
} from 'lucide-react';
import type { ShortCandidate, RepurposeConfig, ShortExport } from '@/react-app/hooks/useContentRepurpose';

interface ContentRepurposePanelProps {
  candidates: ShortCandidate[];
  exports: ShortExport[];
  analyzing: boolean;
  exporting: boolean;
  exportProgress: { current: number; total: number } | null;
  error: string | null;
  selectedCount: number;
  onAnalyze: (config: RepurposeConfig) => Promise<ShortCandidate[]>;
  onToggleCandidate: (id: string) => void;
  onSelectAll: (selected: boolean) => void;
  onUpdateCandidate: (id: string, updates: Partial<ShortCandidate>) => void;
  onExportSelected: (cropTo916: boolean) => Promise<ShortExport[]>;
  onDownloadExport: (exp: ShortExport) => void;
  onDownloadAll: () => void;
  onClear: () => void;
  onClose: () => void;
}

// Format seconds to MM:SS
function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

const PLATFORMS = [
  { value: 'tiktok', label: 'TikTok', maxDuration: 60 },
  { value: 'youtube-shorts', label: 'YouTube Shorts', maxDuration: 60 },
  { value: 'instagram-reels', label: 'Instagram Reels', maxDuration: 90 },
] as const;

export default function ContentRepurposePanel({
  candidates,
  exports,
  analyzing,
  exporting,
  exportProgress,
  error,
  selectedCount,
  onAnalyze,
  onToggleCandidate,
  onSelectAll,
  onUpdateCandidate,
  onExportSelected,
  onDownloadExport,
  onDownloadAll,
  onClear,
  onClose,
}: ContentRepurposePanelProps) {
  const [config, setConfig] = useState<RepurposeConfig>({
    targetPlatform: 'tiktok',
    maxDuration: 60,
    minDuration: 15,
    targetCount: 5,
    cropTo916: true,
  });
  const [editingTitle, setEditingTitle] = useState<string | null>(null);

  const handleAnalyze = useCallback(async () => {
    await onAnalyze(config);
  }, [config, onAnalyze]);

  const handleExport = useCallback(async () => {
    await onExportSelected(config.cropTo916);
  }, [config.cropTo916, onExportSelected]);

  const getViralityColor = (score: number) => {
    if (score >= 80) return 'bg-green-500 text-white';
    if (score >= 60) return 'bg-yellow-500 text-black';
    if (score >= 40) return 'bg-orange-500 text-white';
    return 'bg-zinc-500 text-white';
  };

  const completedExports = exports.filter(e => e.status === 'complete');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[700px] max-h-[90vh] bg-zinc-900 rounded-xl border border-zinc-700 shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Scissors className="w-5 h-5 text-orange-500" />
            <span className="font-medium text-white">Content Repurposing</span>
            <span className="text-xs text-zinc-500">Long video → Multiple shorts</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-zinc-500 hover:text-white rounded"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Config (show when no candidates) */}
          {candidates.length === 0 && !analyzing && (
            <>
              <div className="text-center py-4">
                <div className="w-16 h-16 mx-auto mb-3 rounded-full bg-gradient-to-br from-orange-500/20 to-red-500/20 flex items-center justify-center">
                  <Scissors className="w-8 h-8 text-orange-400" />
                </div>
                <h3 className="text-lg font-medium text-white mb-1">
                  Turn Long Videos Into Shorts
                </h3>
                <p className="text-sm text-zinc-400 max-w-sm mx-auto">
                  AI will find the best moments for viral short-form content
                </p>
              </div>

              {/* Platform Selection */}
              <div>
                <label className="text-xs text-zinc-400 mb-2 block">Platform</label>
                <div className="grid grid-cols-3 gap-2">
                  {PLATFORMS.map((p) => (
                    <button
                      key={p.value}
                      onClick={() => setConfig(c => ({
                        ...c,
                        targetPlatform: p.value as RepurposeConfig['targetPlatform'],
                        maxDuration: p.maxDuration,
                      }))}
                      className={`p-3 rounded-lg border text-center transition-colors ${
                        config.targetPlatform === p.value
                          ? 'border-orange-500 bg-orange-500/10'
                          : 'border-zinc-700 hover:border-zinc-600'
                      }`}
                    >
                      <div className="text-sm font-medium text-white">{p.label}</div>
                      <div className="text-[10px] text-zinc-500">Max {p.maxDuration}s</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Duration Range */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-zinc-400 mb-2 block">Min Duration (s)</label>
                  <input
                    type="number"
                    value={config.minDuration}
                    onChange={(e) => setConfig(c => ({ ...c, minDuration: parseInt(e.target.value) || 15 }))}
                    min={5}
                    max={config.maxDuration - 5}
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-400 mb-2 block">Max Duration (s)</label>
                  <input
                    type="number"
                    value={config.maxDuration}
                    onChange={(e) => setConfig(c => ({ ...c, maxDuration: parseInt(e.target.value) || 60 }))}
                    min={config.minDuration + 5}
                    max={180}
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm"
                  />
                </div>
              </div>

              {/* Target Count */}
              <div>
                <label className="text-xs text-zinc-400 mb-2 block">Number of Shorts</label>
                <div className="flex items-center gap-2">
                  {[3, 5, 7, 10].map((n) => (
                    <button
                      key={n}
                      onClick={() => setConfig(c => ({ ...c, targetCount: n }))}
                      className={`px-4 py-2 rounded-lg border transition-colors ${
                        config.targetCount === n
                          ? 'border-orange-500 bg-orange-500/10 text-white'
                          : 'border-zinc-700 text-zinc-400 hover:border-zinc-600'
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              {/* Crop Option */}
              <div
                onClick={() => setConfig(c => ({ ...c, cropTo916: !c.cropTo916 }))}
                className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                  config.cropTo916
                    ? 'border-orange-500 bg-orange-500/10'
                    : 'border-zinc-700 hover:border-zinc-600'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <div className="text-sm font-medium text-white">Auto-crop to 9:16</div>
                    <div className="text-xs text-zinc-500">Center crop for vertical format</div>
                  </div>
                  <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${
                    config.cropTo916 ? 'border-orange-500 bg-orange-500' : 'border-zinc-600'
                  }`}>
                    {config.cropTo916 && <Check className="w-3 h-3 text-white" />}
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Analyzing State */}
          {analyzing && (
            <div className="text-center py-8">
              <div className="w-8 h-8 mx-auto mb-3 border-2 border-orange-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-zinc-400">Finding viral moments...</p>
              <p className="text-xs text-zinc-500 mt-1">Analyzing transcript and content</p>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-xs text-red-300">
              {error}
            </div>
          )}

          {/* Candidates List */}
          {candidates.length > 0 && !analyzing && (
            <>
              {/* Selection Controls */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-[10px]">
                  <button
                    onClick={() => onSelectAll(true)}
                    className="text-zinc-400 hover:text-white"
                  >
                    Select All
                  </button>
                  <span className="text-zinc-600">|</span>
                  <button
                    onClick={() => onSelectAll(false)}
                    className="text-zinc-400 hover:text-white"
                  >
                    Deselect
                  </button>
                  <span className="text-zinc-600">|</span>
                  <button
                    onClick={onClear}
                    className="text-red-400 hover:text-red-300"
                  >
                    Clear
                  </button>
                </div>
                <span className="text-xs text-zinc-500">
                  {selectedCount}/{candidates.length} selected
                </span>
              </div>

              {/* Candidate Cards */}
              <div className="space-y-2">
                {candidates.map((candidate) => (
                  <div
                    key={candidate.id}
                    className={`rounded-lg border transition-colors ${
                      candidate.selected
                        ? 'border-orange-500 bg-orange-500/5'
                        : 'border-zinc-700 bg-zinc-800'
                    }`}
                  >
                    <div className="p-3">
                      <div className="flex items-start gap-3">
                        {/* Checkbox */}
                        <button
                          onClick={() => onToggleCandidate(candidate.id)}
                          className="mt-1 text-zinc-400 hover:text-white"
                        >
                          {candidate.selected ? (
                            <CheckSquare className="w-5 h-5 text-orange-500" />
                          ) : (
                            <Square className="w-5 h-5" />
                          )}
                        </button>

                        {/* Thumbnail */}
                        {candidate.thumbnailUrl && (
                          <div className="w-16 h-28 rounded overflow-hidden bg-zinc-700 flex-shrink-0">
                            <img
                              src={`http://localhost:3333${candidate.thumbnailUrl}`}
                              alt={candidate.suggestedTitle}
                              className="w-full h-full object-cover"
                              crossOrigin="anonymous"
                            />
                          </div>
                        )}

                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          {/* Title */}
                          {editingTitle === candidate.id ? (
                            <input
                              autoFocus
                              defaultValue={candidate.suggestedTitle}
                              onBlur={(e) => {
                                onUpdateCandidate(candidate.id, { suggestedTitle: e.target.value });
                                setEditingTitle(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  onUpdateCandidate(candidate.id, { suggestedTitle: e.currentTarget.value });
                                  setEditingTitle(null);
                                }
                                if (e.key === 'Escape') setEditingTitle(null);
                              }}
                              className="w-full px-2 py-1 bg-zinc-700 border border-zinc-600 rounded text-sm"
                            />
                          ) : (
                            <div
                              onClick={() => setEditingTitle(candidate.id)}
                              className="text-sm font-medium text-white cursor-text hover:text-orange-400 flex items-center gap-1"
                            >
                              {candidate.suggestedTitle}
                              <Edit3 className="w-3 h-3 text-zinc-500" />
                            </div>
                          )}

                          {/* Timing */}
                          <div className="flex items-center gap-2 mt-1">
                            <Clock className="w-3 h-3 text-zinc-500" />
                            <span className="text-[10px] text-zinc-500">
                              {formatTime(candidate.startTime)} - {formatTime(candidate.endTime)}
                            </span>
                            <span className="text-[10px] text-zinc-600">
                              ({candidate.duration.toFixed(0)}s)
                            </span>
                          </div>

                          {/* Virality Score */}
                          <div className="flex items-center gap-2 mt-2">
                            <TrendingUp className="w-3 h-3 text-zinc-500" />
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${getViralityColor(candidate.viralityScore)}`}>
                              {candidate.viralityScore}% viral
                            </span>
                          </div>

                          {/* Virality Factors */}
                          {candidate.viralityFactors.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                              {candidate.viralityFactors.slice(0, 3).map((factor, idx) => (
                                <span
                                  key={idx}
                                  className="px-1.5 py-0.5 bg-zinc-700 rounded text-[9px] text-zinc-400"
                                >
                                  {factor}
                                </span>
                              ))}
                            </div>
                          )}

                          {/* Hook Preview */}
                          {candidate.suggestedHook && (
                            <div className="mt-2 p-2 bg-zinc-700/50 rounded text-[10px] text-zinc-400">
                              <span className="text-zinc-500">Hook:</span> "{candidate.suggestedHook}"
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Export Progress */}
              {exporting && exportProgress && (
                <div className="p-3 bg-orange-500/10 border border-orange-500/30 rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-white">Exporting shorts...</span>
                    <span className="text-xs text-zinc-400">
                      {exportProgress.current}/{exportProgress.total}
                    </span>
                  </div>
                  <div className="h-2 bg-zinc-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-orange-500 transition-all"
                      style={{ width: `${(exportProgress.current / exportProgress.total) * 100}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Export Results */}
              {completedExports.length > 0 && !exporting && (
                <div className="p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Check className="w-4 h-4 text-green-500" />
                      <span className="text-sm text-white">{completedExports.length} shorts ready</span>
                    </div>
                    <button
                      onClick={onDownloadAll}
                      className="flex items-center gap-1 px-2 py-1 bg-green-500 hover:bg-green-600 rounded text-xs font-medium"
                    >
                      <Download className="w-3 h-3" />
                      Download All
                    </button>
                  </div>
                  <div className="space-y-1">
                    {completedExports.map((exp) => (
                      <div
                        key={exp.candidateId}
                        className="flex items-center justify-between text-xs"
                      >
                        <span className="text-zinc-400">{exp.filename}</span>
                        <button
                          onClick={() => onDownloadExport(exp)}
                          className="text-green-400 hover:text-green-300"
                        >
                          Download
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Actions */}
        <div className="p-4 border-t border-zinc-800">
          {candidates.length === 0 ? (
            <button
              onClick={handleAnalyze}
              disabled={analyzing}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 rounded-lg font-medium transition-colors"
            >
              <Sparkles className="w-5 h-5" />
              Find Shorts
            </button>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={handleExport}
                disabled={exporting || selectedCount === 0}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
              >
                <Download className="w-4 h-4" />
                Export {selectedCount} Short{selectedCount !== 1 ? 's' : ''}
              </button>
              <button
                onClick={handleAnalyze}
                disabled={analyzing}
                className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded-lg text-sm transition-colors"
              >
                Re-analyze
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
