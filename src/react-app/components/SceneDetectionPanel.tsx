import { useState, useCallback } from 'react';
import {
  Scissors, Play, Merge, GitBranch,
  Download, ChevronDown, ChevronUp, Sparkles,
  CheckSquare, Square, Layers, X
} from 'lucide-react';
import type { DetectedScene } from '@/react-app/hooks/useProject';

interface SceneDetectionPanelProps {
  scenes: DetectedScene[];
  loading: boolean;
  error: string | null;
  currentTime: number;
  projectDuration: number;
  onDetectScenes: () => Promise<void>;
  onToggleSelection: (sceneId: string) => void;
  onSelectAll: (selected: boolean) => void;
  onUpdateScene: (sceneId: string, updates: Partial<DetectedScene>) => void;
  onMergeScenes: (id1: string, id2: string) => void;
  onSplitScene: (sceneId: string, splitTime: number) => void;
  onSplitAll: () => void;
  onExportSelected: () => void;
  onSeekTo: (time: number) => void;
  onClearScenes: () => void;
  onClose: () => void;
}

// Format seconds to MM:SS
function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Format duration with decimals
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs.toFixed(0)}s`;
}

export default function SceneDetectionPanel({
  scenes,
  loading,
  error,
  currentTime,
  projectDuration,
  onDetectScenes,
  onToggleSelection,
  onSelectAll,
  onUpdateScene,
  onMergeScenes,
  onSplitScene,
  onSplitAll,
  onExportSelected,
  onSeekTo,
  onClearScenes,
  onClose,
}: SceneDetectionPanelProps) {
  const [expandedScene, setExpandedScene] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [mergeMode, setMergeMode] = useState<string | null>(null);

  const selectedCount = scenes.filter(s => s.selected).length;

  const handleTitleEdit = useCallback((sceneId: string, newTitle: string) => {
    onUpdateScene(sceneId, { title: newTitle });
    setEditingTitle(null);
  }, [onUpdateScene]);

  const handleMergeClick = useCallback((sceneId: string) => {
    if (mergeMode === null) {
      setMergeMode(sceneId);
    } else if (mergeMode !== sceneId) {
      onMergeScenes(mergeMode, sceneId);
      setMergeMode(null);
    } else {
      setMergeMode(null);
    }
  }, [mergeMode, onMergeScenes]);

  // Find current scene based on playhead
  const currentScene = scenes.find(s =>
    currentTime >= s.startTime && currentTime < s.endTime
  );

  return (
    <div className="flex flex-col h-full bg-zinc-900 border-l border-zinc-800">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/50">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-orange-500" />
          <span className="text-sm font-medium text-white">Smart Scenes</span>
        </div>
        <div className="flex items-center gap-2">
          {scenes.length > 0 && (
            <span className="text-[10px] text-zinc-500">
              {selectedCount}/{scenes.length}
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
        {/* Detect Button (empty state) */}
        {scenes.length === 0 && !loading && (
          <div className="text-center py-8">
            <Layers className="w-12 h-12 mx-auto text-zinc-600 mb-3" />
            <p className="text-sm text-zinc-400 mb-2">
              Smart Scene Detection
            </p>
            <p className="text-xs text-zinc-500 mb-4 px-4">
              Analyze your video's transcript to automatically detect topic changes and scene breaks
            </p>
            <button
              onClick={() => onDetectScenes()}
              disabled={loading}
              className="flex items-center gap-2 mx-auto px-4 py-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
            >
              <Sparkles className="w-4 h-4" />
              Detect Scenes
            </button>
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className="text-center py-8">
            <div className="w-8 h-8 mx-auto mb-3 border-2 border-orange-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-zinc-400">Analyzing transcript...</p>
            <p className="text-xs text-zinc-500 mt-1">This may take a moment</p>
          </div>
        )}

        {error && (
          <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-xs text-red-300">
            {error}
          </div>
        )}

        {/* Scene List */}
        {scenes.length > 0 && !loading && (
          <>
            {/* Selection controls */}
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
                onClick={onClearScenes}
                className="text-red-400 hover:text-red-300"
              >
                Clear
              </button>
              {mergeMode && (
                <>
                  <span className="text-zinc-600">|</span>
                  <span className="text-purple-400">Select scene to merge</span>
                </>
              )}
            </div>

            {/* Scene cards */}
            <div className="space-y-2">
              {scenes.map((scene) => (
                <div
                  key={scene.id}
                  className={`rounded-lg border transition-colors ${
                    currentScene?.id === scene.id
                      ? 'border-orange-500 bg-orange-500/10'
                      : mergeMode === scene.id
                        ? 'border-purple-500 bg-purple-500/10'
                        : mergeMode && mergeMode !== scene.id
                          ? 'border-purple-500/50 bg-zinc-800 cursor-pointer hover:bg-purple-500/20'
                          : 'border-zinc-700 bg-zinc-800'
                  }`}
                  onClick={mergeMode && mergeMode !== scene.id ? () => handleMergeClick(scene.id) : undefined}
                >
                  <div className="p-2">
                    <div className="flex items-start gap-2">
                      {/* Selection checkbox */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleSelection(scene.id);
                        }}
                        className="mt-1 text-zinc-400 hover:text-white"
                      >
                        {scene.selected ? (
                          <CheckSquare className="w-4 h-4 text-orange-500" />
                        ) : (
                          <Square className="w-4 h-4" />
                        )}
                      </button>

                      {/* Thumbnail */}
                      <div
                        className="w-16 h-10 rounded bg-zinc-700 overflow-hidden flex-shrink-0 cursor-pointer hover:ring-2 hover:ring-orange-500"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSeekTo(scene.startTime);
                        }}
                      >
                        {scene.thumbnailUrl ? (
                          <img
                            src={scene.thumbnailUrl}
                            alt={scene.title}
                            className="w-full h-full object-cover"
                            crossOrigin="anonymous"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Play className="w-3 h-3 text-zinc-500" />
                          </div>
                        )}
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        {editingTitle === scene.id ? (
                          <input
                            autoFocus
                            defaultValue={scene.title}
                            onClick={(e) => e.stopPropagation()}
                            onBlur={(e) => handleTitleEdit(scene.id, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleTitleEdit(scene.id, e.currentTarget.value);
                              if (e.key === 'Escape') setEditingTitle(null);
                            }}
                            className="w-full px-1 bg-zinc-700 border border-zinc-600 rounded text-xs"
                          />
                        ) : (
                          <div
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingTitle(scene.id);
                            }}
                            className="text-xs font-medium text-white truncate cursor-text hover:text-orange-400"
                          >
                            {scene.title}
                          </div>
                        )}
                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          <span className="text-[10px] text-zinc-500">
                            {formatTime(scene.startTime)} - {formatTime(scene.endTime)}
                          </span>
                          <span className="text-[10px] text-zinc-600">
                            ({formatDuration(scene.duration)})
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 mt-1">
                          {scene.isVisualBreak && (
                            <span className="text-[9px] px-1 py-0.5 bg-blue-500/20 text-blue-400 rounded">
                              Visual
                            </span>
                          )}
                          <span className={`text-[9px] px-1 py-0.5 rounded ${
                            scene.confidence > 0.7
                              ? 'bg-green-500/20 text-green-400'
                              : scene.confidence > 0.4
                                ? 'bg-yellow-500/20 text-yellow-400'
                                : 'bg-zinc-500/20 text-zinc-400'
                          }`}>
                            {Math.round(scene.confidence * 100)}%
                          </span>
                        </div>
                      </div>

                      {/* Expand/collapse */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedScene(expandedScene === scene.id ? null : scene.id);
                        }}
                        className="p-1 text-zinc-500 hover:text-white"
                      >
                        {expandedScene === scene.id ? (
                          <ChevronUp className="w-4 h-4" />
                        ) : (
                          <ChevronDown className="w-4 h-4" />
                        )}
                      </button>
                    </div>

                    {/* Expanded controls */}
                    {expandedScene === scene.id && (
                      <div
                        className="mt-2 pt-2 border-t border-zinc-700 space-y-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {/* Time adjustment */}
                        <div className="flex gap-2">
                          <div className="flex-1">
                            <label className="text-[10px] text-zinc-500">Start</label>
                            <input
                              type="number"
                              step="0.1"
                              value={scene.startTime.toFixed(1)}
                              onChange={(e) => onUpdateScene(scene.id, {
                                startTime: parseFloat(e.target.value)
                              })}
                              className="w-full px-1.5 py-1 bg-zinc-700 border border-zinc-600 rounded text-[10px]"
                            />
                          </div>
                          <div className="flex-1">
                            <label className="text-[10px] text-zinc-500">End</label>
                            <input
                              type="number"
                              step="0.1"
                              value={scene.endTime.toFixed(1)}
                              onChange={(e) => onUpdateScene(scene.id, {
                                endTime: parseFloat(e.target.value)
                              })}
                              className="w-full px-1.5 py-1 bg-zinc-700 border border-zinc-600 rounded text-[10px]"
                            />
                          </div>
                        </div>

                        {/* Action buttons */}
                        <div className="flex gap-1">
                          <button
                            onClick={() => onSeekTo(scene.startTime)}
                            className="flex-1 flex items-center justify-center gap-1 px-2 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-[10px]"
                          >
                            <Play className="w-3 h-3" />
                            Preview
                          </button>
                          <button
                            onClick={() => handleMergeClick(scene.id)}
                            className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-[10px] ${
                              mergeMode === scene.id
                                ? 'bg-purple-500 text-white'
                                : 'bg-zinc-700 hover:bg-zinc-600'
                            }`}
                          >
                            <Merge className="w-3 h-3" />
                            {mergeMode === scene.id ? 'Cancel' : 'Merge'}
                          </button>
                          <button
                            onClick={() => onSplitScene(scene.id, (scene.startTime + scene.endTime) / 2)}
                            className="flex-1 flex items-center justify-center gap-1 px-2 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-[10px]"
                          >
                            <GitBranch className="w-3 h-3" />
                            Split
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Action buttons */}
      {scenes.length > 0 && !loading && (
        <div className="p-3 border-t border-zinc-800/50 space-y-2">
          <button
            onClick={onSplitAll}
            disabled={selectedCount === 0}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
          >
            <Scissors className="w-4 h-4" />
            Split Timeline ({selectedCount})
          </button>
          <button
            onClick={onExportSelected}
            disabled={selectedCount === 0}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 rounded-lg text-sm transition-colors"
          >
            <Download className="w-4 h-4" />
            Export Selected
          </button>
          <button
            onClick={() => onDetectScenes()}
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
