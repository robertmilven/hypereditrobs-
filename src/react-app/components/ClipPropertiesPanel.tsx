import { useCallback, useMemo } from 'react';
import { Move, RotateCw, Crop, X, Sparkles } from 'lucide-react';
import type { TimelineClip, Asset, TransitionType, ClipTransition } from '@/react-app/hooks/useProject';

interface ClipTransform {
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  opacity?: number;
  cropTop?: number;
  cropBottom?: number;
  cropLeft?: number;
  cropRight?: number;
}

const TRANSITION_OPTIONS: { type: TransitionType; label: string; icon: string }[] = [
  { type: 'none', label: 'None', icon: '✕' },
  { type: 'crossfade', label: 'Crossfade', icon: '◐' },
  { type: 'wipe-left', label: 'Wipe Left', icon: '◀' },
  { type: 'wipe-right', label: 'Wipe Right', icon: '▶' },
  { type: 'wipe-up', label: 'Wipe Up', icon: '▲' },
  { type: 'wipe-down', label: 'Wipe Down', icon: '▼' },
  { type: 'slide-left', label: 'Slide L', icon: '⇐' },
  { type: 'slide-right', label: 'Slide R', icon: '⇒' },
  { type: 'zoom-in', label: 'Zoom In', icon: '⊕' },
  { type: 'zoom-out', label: 'Zoom Out', icon: '⊖' },
];

interface ClipPropertiesPanelProps {
  clip: TimelineClip | null;
  asset: Asset | null;
  allClips?: TimelineClip[]; // All clips to detect adjacent V1 clips
  onUpdateTransform: (clipId: string, transform: ClipTransform) => void;
  onUpdateTransition?: (clipId: string, transition: ClipTransition | undefined) => void;
  onClose: () => void;
}

export default function ClipPropertiesPanel({
  clip,
  asset,
  allClips = [],
  onUpdateTransform,
  onUpdateTransition,
  onClose,
}: ClipPropertiesPanelProps) {
  // Check if this V1 clip has a preceding V1 clip (needed to show transition options)
  const hasPrecedingV1Clip = useMemo(() => {
    if (!clip || clip.trackId !== 'V1') return false;
    const v1Clips = allClips
      .filter(c => c.trackId === 'V1')
      .sort((a, b) => a.start - b.start);
    const idx = v1Clips.findIndex(c => c.id === clip.id);
    return idx > 0;
  }, [clip, allClips]);

  if (!clip || !asset) {
    return (
      <div className="p-3 text-center text-zinc-500 text-xs">
        Select a clip to edit its properties
      </div>
    );
  }

  const transform = clip.transform || {};

  const handleScaleChange = useCallback((value: number) => {
    onUpdateTransform(clip.id, { ...transform, scale: value });
  }, [clip.id, transform, onUpdateTransform]);

  const handleRotationChange = useCallback((value: number) => {
    onUpdateTransform(clip.id, { ...transform, rotation: value });
  }, [clip.id, transform, onUpdateTransform]);

  const handlePositionChange = useCallback((axis: 'x' | 'y', value: number) => {
    onUpdateTransform(clip.id, { ...transform, [axis]: value });
  }, [clip.id, transform, onUpdateTransform]);

  const handleCropChange = useCallback((side: 'cropTop' | 'cropBottom' | 'cropLeft' | 'cropRight', value: number) => {
    onUpdateTransform(clip.id, { ...transform, [side]: value });
  }, [clip.id, transform, onUpdateTransform]);

  const handleReset = useCallback(() => {
    onUpdateTransform(clip.id, {
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      opacity: 1,
      cropTop: 0,
      cropBottom: 0,
      cropLeft: 0,
      cropRight: 0,
    });
  }, [clip.id, onUpdateTransform]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/50">
        <span className="text-xs font-medium text-zinc-400">Clip Properties</span>
        <button
          onClick={onClose}
          className="p-1 hover:bg-zinc-700 rounded transition-colors"
          title="Deselect clip"
        >
          <X className="w-3.5 h-3.5 text-zinc-500" />
        </button>
      </div>

      {/* Clip info */}
      <div className="px-3 py-2 border-b border-zinc-800/50">
        <div className="text-xs text-white font-medium truncate">{asset.filename}</div>
        <div className="text-[10px] text-zinc-500 mt-0.5">
          {asset.type} • {asset.width && asset.height ? `${asset.width}x${asset.height}` : 'N/A'}
        </div>
      </div>

      {/* Properties */}
      <div className="flex-1 overflow-auto p-3 space-y-4">
        {/* Scale */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Move className="w-3.5 h-3.5 text-zinc-500" />
            <span className="text-xs font-medium text-zinc-300">Scale</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min="0.1"
              max="3"
              step="0.05"
              value={transform.scale ?? 1}
              onChange={(e) => handleScaleChange(parseFloat(e.target.value))}
              className="flex-1 h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
            />
            <span className="text-xs text-zinc-400 w-12 text-right">
              {((transform.scale ?? 1) * 100).toFixed(0)}%
            </span>
          </div>
        </div>

        {/* Rotation */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <RotateCw className="w-3.5 h-3.5 text-zinc-500" />
            <span className="text-xs font-medium text-zinc-300">Rotation</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min="-180"
              max="180"
              step="1"
              value={transform.rotation ?? 0}
              onChange={(e) => handleRotationChange(parseFloat(e.target.value))}
              className="flex-1 h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
            />
            <span className="text-xs text-zinc-400 w-12 text-right">
              {(transform.rotation ?? 0).toFixed(0)}°
            </span>
          </div>
        </div>

        {/* Position */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Move className="w-3.5 h-3.5 text-zinc-500" />
            <span className="text-xs font-medium text-zinc-300">Position</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-zinc-500 mb-1 block">X</label>
              <input
                type="number"
                value={transform.x ?? 0}
                onChange={(e) => handlePositionChange('x', parseFloat(e.target.value) || 0)}
                className="w-full px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-white"
              />
            </div>
            <div>
              <label className="text-[10px] text-zinc-500 mb-1 block">Y</label>
              <input
                type="number"
                value={transform.y ?? 0}
                onChange={(e) => handlePositionChange('y', parseFloat(e.target.value) || 0)}
                className="w-full px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-white"
              />
            </div>
          </div>
        </div>

        {/* Crop */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Crop className="w-3.5 h-3.5 text-zinc-500" />
            <span className="text-xs font-medium text-zinc-300">Crop</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-zinc-500 mb-1 block">Top %</label>
              <input
                type="number"
                min="0"
                max="50"
                value={transform.cropTop ?? 0}
                onChange={(e) => handleCropChange('cropTop', parseFloat(e.target.value) || 0)}
                className="w-full px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-white"
              />
            </div>
            <div>
              <label className="text-[10px] text-zinc-500 mb-1 block">Bottom %</label>
              <input
                type="number"
                min="0"
                max="50"
                value={transform.cropBottom ?? 0}
                onChange={(e) => handleCropChange('cropBottom', parseFloat(e.target.value) || 0)}
                className="w-full px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-white"
              />
            </div>
            <div>
              <label className="text-[10px] text-zinc-500 mb-1 block">Left %</label>
              <input
                type="number"
                min="0"
                max="50"
                value={transform.cropLeft ?? 0}
                onChange={(e) => handleCropChange('cropLeft', parseFloat(e.target.value) || 0)}
                className="w-full px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-white"
              />
            </div>
            <div>
              <label className="text-[10px] text-zinc-500 mb-1 block">Right %</label>
              <input
                type="number"
                min="0"
                max="50"
                value={transform.cropRight ?? 0}
                onChange={(e) => handleCropChange('cropRight', parseFloat(e.target.value) || 0)}
                className="w-full px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-white"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Transition section (V1 clips with a preceding clip) */}
      {hasPrecedingV1Clip && onUpdateTransition && (
        <div className="px-3 py-3 border-t border-zinc-800/50 space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-3.5 h-3.5 text-orange-400" />
            <span className="text-xs font-medium text-zinc-300">Transition</span>
          </div>

          {/* Type grid */}
          <div className="grid grid-cols-5 gap-1">
            {TRANSITION_OPTIONS.map(opt => {
              const isActive = (clip.transition?.type || 'none') === opt.type;
              return (
                <button
                  key={opt.type}
                  onClick={() => {
                    if (opt.type === 'none') {
                      onUpdateTransition(clip.id, undefined);
                    } else {
                      onUpdateTransition(clip.id, {
                        type: opt.type,
                        duration: clip.transition?.duration ?? 0.5,
                      });
                    }
                  }}
                  className={`flex flex-col items-center gap-0.5 p-1.5 rounded text-center transition-colors ${
                    isActive
                      ? 'bg-orange-500/30 ring-1 ring-orange-400 text-orange-300'
                      : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400'
                  }`}
                  title={opt.label}
                >
                  <span className="text-sm leading-none">{opt.icon}</span>
                  <span className="text-[8px] leading-none truncate w-full">{opt.label}</span>
                </button>
              );
            })}
          </div>

          {/* Duration slider (only when a transition is active) */}
          {clip.transition && clip.transition.type !== 'none' && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-zinc-500">Duration</span>
                <span className="text-[10px] text-zinc-400">{clip.transition.duration.toFixed(1)}s</span>
              </div>
              <input
                type="range"
                min="0.1"
                max="2.0"
                step="0.1"
                value={clip.transition.duration}
                onChange={(e) => {
                  onUpdateTransition(clip.id, {
                    type: clip.transition!.type,
                    duration: parseFloat(e.target.value),
                  });
                }}
                className="w-full h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-orange-500"
              />
            </div>
          )}
        </div>
      )}

      {/* Reset button */}
      <div className="p-3 border-t border-zinc-800/50">
        <button
          onClick={handleReset}
          className="w-full px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 rounded text-xs font-medium transition-colors"
        >
          Reset All
        </button>
      </div>
    </div>
  );
}
