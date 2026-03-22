import { Play, Image as ImageIcon, Layers, Move } from 'lucide-react';
import { useRef, useEffect, forwardRef, useImperativeHandle, useMemo, useState, useCallback } from 'react';
import CaptionRenderer from './CaptionRenderer';
import type { CaptionWord, CaptionStyle, FrameTemplate, Asset } from '@/react-app/hooks/useProject';
import type { OverlayAsset } from '@/react-app/hooks/useOverlayAssets';

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

interface ClipLayer {
  id: string;
  url: string;
  type: 'video' | 'image' | 'audio' | 'caption';
  trackId: string;
  clipTime: number;
  transform?: ClipTransform;
  // Caption-specific data
  captionWords?: CaptionWord[];
  captionStyle?: CaptionStyle;
}

interface VideoPreviewProps {
  layers?: ClipLayer[];
  isPlaying?: boolean;
  aspectRatio?: '16:9' | '9:16';
  currentTime?: number; // Current playback time in seconds
  projectDuration?: number; // Total project duration in seconds
  onLayerMove?: (layerId: string, x: number, y: number) => void;
  onLayerSelect?: (layerId: string) => void;
  selectedLayerId?: string | null;
  frameTemplate?: FrameTemplate | null;
  assets?: Asset[];
  overlayAssets?: OverlayAsset[]; // Passed from parent to share state
}

export interface VideoPreviewHandle {
  seekTo: (time: number) => void;
  getVideoElement: () => HTMLVideoElement | null;
}

// Helper to build CSS styles from transform
function getTransformStyles(transform?: ClipTransform, zIndex: number = 0, isDragging?: boolean): React.CSSProperties {
  const t = transform || {};

  const transforms: string[] = [];

  // Position (translate)
  if (t.x || t.y) {
    transforms.push(`translate(${t.x || 0}px, ${t.y || 0}px)`);
  }

  // Scale
  if (t.scale && t.scale !== 1) {
    transforms.push(`scale(${t.scale})`);
  }

  // Rotation
  if (t.rotation) {
    transforms.push(`rotate(${t.rotation}deg)`);
  }

  // Crop using clip-path
  const cropTop = t.cropTop || 0;
  const cropBottom = t.cropBottom || 0;
  const cropLeft = t.cropLeft || 0;
  const cropRight = t.cropRight || 0;
  const hasClip = cropTop || cropBottom || cropLeft || cropRight;

  return {
    zIndex,
    transform: transforms.length > 0 ? transforms.join(' ') : undefined,
    opacity: t.opacity ?? 1,
    clipPath: hasClip
      ? `inset(${cropTop}% ${cropRight}% ${cropBottom}% ${cropLeft}%)`
      : undefined,
    cursor: isDragging ? 'grabbing' : undefined,
  };
}

// Helper to get background style from frame template
function getFrameBackgroundStyle(template: FrameTemplate, baseVideoUrl?: string): React.CSSProperties {
  const bg = template.background;

  switch (bg.type) {
    case 'solid':
      return { backgroundColor: bg.color || '#000000' };
    case 'gradient':
      return {
        background: `linear-gradient(${bg.gradientAngle || 180}deg, ${bg.gradientStart || '#1a1a2e'}, ${bg.gradientEnd || '#16213e'})`,
      };
    case 'blur':
      // Blur is handled separately with a video element
      return {};
    case 'image':
      // Image is handled separately with an img element
      return {};
    default:
      return { backgroundColor: '#000000' };
  }
}

const VideoPreview = forwardRef<VideoPreviewHandle, VideoPreviewProps>(({
  layers = [],
  isPlaying = false,
  aspectRatio = '16:9',
  currentTime = 0,
  projectDuration = 60,
  onLayerMove,
  onLayerSelect,
  selectedLayerId,
  frameTemplate,
  assets = [],
  overlayAssets = [], // Received from parent - shared state
}, ref) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const loadedSrcRef = useRef<string | null>(null);
  const overlayVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const [draggingLayer, setDraggingLayer] = useState<string | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number; layerX: number; layerY: number } | null>(null);

  // Find the base video layer (V1) for audio/playback control
  const foundBaseLayer = layers.find(l => l.trackId === 'V1' && l.type === 'video');
  const baseLayerId = foundBaseLayer?.id;
  const baseLayerUrl = foundBaseLayer?.url;
  const baseLayerClipTime = foundBaseLayer?.clipTime;

  // Memoize to prevent effect triggers when only caption layers change
  const baseVideoLayer = useMemo(() => {
    return foundBaseLayer;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseLayerId, baseLayerUrl]);

  // Get all layers sorted by track for rendering (V1 at bottom, then V2/V3, then T1 captions on top)
  const sortedLayers = useMemo(() => {
    const getTrackOrder = (trackId: string) => {
      if (trackId === 'V1') return 0;
      if (trackId === 'V2') return 1;
      if (trackId === 'V3') return 2;
      if (trackId.startsWith('T')) return 10; // Text/caption tracks on top
      return 5; // Other tracks in between
    };
    return [...layers].sort((a, b) => getTrackOrder(a.trackId) - getTrackOrder(b.trackId));
  }, [layers]);

  useImperativeHandle(ref, () => ({
    seekTo: (time: number) => {
      if (videoRef.current) videoRef.current.currentTime = time;
    },
    getVideoElement: () => videoRef.current,
  }));

  // Reload video when source URL changes (e.g., clip boundary or after dead air removal)
  // Using stable key + manual load() preserves the audio permission from user gesture
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !baseLayerUrl) return;
    if (loadedSrcRef.current !== baseLayerUrl) {
      if (loadedSrcRef.current) {
        console.log('[VideoPreview] Source changed, reloading video with audio');
        console.log('[VideoPreview] Old:', loadedSrcRef.current?.slice(-60));
        console.log('[VideoPreview] New:', baseLayerUrl.slice(-60));
      }
      video.src = baseLayerUrl;
      video.load();
      loadedSrcRef.current = baseLayerUrl;

      // After loading a new source, seek to correct position and resume playback
      // video.load() resets the element, so .play() must be called again
      video.addEventListener('loadeddata', () => {
        if (baseLayerClipTime !== undefined) {
          video.currentTime = baseLayerClipTime;
        }
        if (isPlaying) {
          video.play().catch(() => {});
        }
      }, { once: true });
    }
  }, [baseLayerUrl, baseLayerClipTime, isPlaying]);

  // Seek control for base video (when paused/scrubbing)
  useEffect(() => {
    const video = videoRef.current;
    if (!video || baseLayerClipTime === undefined) return;
    if (isPlaying) return;

    if (Math.abs(video.currentTime - baseLayerClipTime) > 0.1) {
      video.currentTime = baseLayerClipTime;
    }
  }, [baseLayerClipTime, isPlaying]);

  // Sync base video during playback — correct drift so audio/video don't stall
  useEffect(() => {
    const video = videoRef.current;
    if (!video || baseLayerClipTime === undefined) return;
    if (!isPlaying) return;

    const drift = Math.abs(video.currentTime - baseLayerClipTime);
    if (drift > 0.15) {
      video.currentTime = baseLayerClipTime;
      // Re-trigger play in case seeking paused it
      video.play().catch(() => {});
    }
  }, [baseLayerClipTime, isPlaying]);

  // Play/pause control for base video
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying) {
      console.log('[VideoPreview] Playing base video:', { src: video.src?.slice(-60), muted: video.muted, volume: video.volume, readyState: video.readyState, networkState: video.networkState });
      video.play().catch((err) => {
        console.error('[VideoPreview] Play failed:', err.name, err.message);
      });
    } else {
      video.pause();
    }
  }, [isPlaying]);

  // Play/pause control for overlay videos (V2, V3, etc.)
  useEffect(() => {
    overlayVideoRefs.current.forEach((video) => {
      if (isPlaying) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    });
  }, [isPlaying]);

  // Sync overlay video and audio seeking when scrubbing
  useEffect(() => {
    if (isPlaying) return;

    const overlayMediaLayers = layers.filter(
      l => (l.type === 'video' && l.trackId !== 'V1') || l.type === 'audio'
    );

    overlayMediaLayers.forEach((layer) => {
      const mediaEl = overlayVideoRefs.current.get(layer.id);
      if (mediaEl && layer.clipTime !== undefined) {
        if (Math.abs(mediaEl.currentTime - layer.clipTime) > 0.1) {
          mediaEl.currentTime = layer.clipTime;
        }
      }
    });
  }, [layers, isPlaying]);

  // Sync overlay videos/audio during playback — correct drift
  useEffect(() => {
    if (!isPlaying) return;

    const overlayMediaLayers = layers.filter(
      l => (l.type === 'video' && l.trackId !== 'V1') || l.type === 'audio'
    );

    overlayMediaLayers.forEach((layer) => {
      const mediaEl = overlayVideoRefs.current.get(layer.id);
      if (mediaEl && layer.clipTime !== undefined) {
        const drift = Math.abs(mediaEl.currentTime - layer.clipTime);
        if (drift > 0.15) {
          mediaEl.currentTime = layer.clipTime;
          mediaEl.play().catch(() => {});
        }
      }
    });
  }, [layers, isPlaying]);

  // Seek on load
  const handleLoaded = () => {
    if (videoRef.current && baseLayerClipTime !== undefined) {
      videoRef.current.currentTime = baseLayerClipTime;
    }
  };

  // Handle mouse down on draggable layer
  const handleLayerMouseDown = useCallback((e: React.MouseEvent, layer: ClipLayer) => {
    // Only allow dragging non-V1 layers (overlays)
    if (layer.trackId === 'V1') return;
    if (e.button !== 0) return;

    e.preventDefault();
    e.stopPropagation();

    setDraggingLayer(layer.id);
    setDragStart({
      x: e.clientX,
      y: e.clientY,
      layerX: layer.transform?.x || 0,
      layerY: layer.transform?.y || 0,
    });

    // Select this layer
    onLayerSelect?.(layer.id);
  }, [onLayerSelect]);

  // Handle mouse move for dragging
  useEffect(() => {
    if (!draggingLayer || !dragStart) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - dragStart.x;
      const deltaY = e.clientY - dragStart.y;

      const newX = dragStart.layerX + deltaX;
      const newY = dragStart.layerY + deltaY;

      onLayerMove?.(draggingLayer, newX, newY);
    };

    const handleMouseUp = () => {
      setDraggingLayer(null);
      setDragStart(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingLayer, dragStart, onLayerMove]);

  // Aspect ratio styles
  const isVertical = aspectRatio === '9:16';
  // Use object-contain to show full video without cropping
  const videoFitClass = 'object-contain';

  // Container classes based on aspect ratio
  const containerClass = isVertical
    ? 'h-[65vh] w-auto aspect-[9/16]'  // Vertical: fixed height, width from aspect ratio
    : 'w-full max-w-4xl aspect-video';  // Horizontal: constrain width, height follows

  if (layers.length === 0) {
    return (
      <div className={`relative ${containerClass} bg-black rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/10 flex items-center justify-center`}>
        <div className="text-center text-zinc-600">
          <Play className="w-12 h-12 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No media to display</p>
        </div>
      </div>
    );
  }

  // Separate base video from overlay layers to prevent re-render issues
  const overlayLayers = useMemo(() =>
    sortedLayers.filter(l => !(l.trackId === 'V1' && l.type === 'video')),
    [sortedLayers]
  );

  // Get asset URL helper - checks both overlay assets and project assets
  const getAssetUrl = useCallback((assetId: string) => {
    // First check overlay assets (for logos, video overlays in frame templates)
    const overlayAsset = overlayAssets.find(a => a.id === assetId);
    if (overlayAsset) {
      console.log('[VideoPreview] Found overlay asset:', assetId, '-> URL:', overlayAsset.url);
      return overlayAsset.url;
    }
    // Fall back to project assets
    const asset = assets.find(a => a.id === assetId);
    const url = asset?.streamUrl || asset?.thumbnailUrl || '';
    console.log('[VideoPreview] Looking for asset:', assetId, '-> Found:', !!asset, '-> URL:', url || '(empty)');
    return url;
  }, [overlayAssets, assets]);

  // Is vertical with frame template active?
  const isVerticalWithFrame = aspectRatio === '9:16' && frameTemplate;

  return (
    <div
      ref={containerRef}
      className={`relative ${containerClass} bg-black rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/10`}
    >
      {/* Frame Template Background (only for 9:16 with active template) */}
      {isVerticalWithFrame && (
        <>
          {/* Solid or Gradient background */}
          {(frameTemplate.background.type === 'solid' || frameTemplate.background.type === 'gradient') && (
            <div
              className="absolute inset-0"
              style={{ ...getFrameBackgroundStyle(frameTemplate), zIndex: 0 }}
            />
          )}

          {/* Blur background - uses the base video blurred */}
          {frameTemplate.background.type === 'blur' && foundBaseLayer && (
            <div className="absolute inset-0 overflow-hidden" style={{ zIndex: 0 }}>
              <video
                src={foundBaseLayer.url}
                className="absolute w-full h-full object-cover scale-110"
                style={{ filter: `blur(${frameTemplate.background.blurAmount || 20}px)` }}
                muted
                playsInline
                autoPlay={isPlaying}
                loop
              />
            </div>
          )}

          {/* Image background */}
          {frameTemplate.background.type === 'image' && frameTemplate.background.imageAssetId && (
            <div className="absolute inset-0" style={{ zIndex: 0 }}>
              <img
                src={getAssetUrl(frameTemplate.background.imageAssetId)}
                alt="Background"
                className="w-full h-full object-cover"
              />
            </div>
          )}
        </>
      )}

      {/* Base video layer (V1) - rendered separately for stability */}
      {foundBaseLayer && (
        <video
          key="base-video"
          ref={videoRef}
          src={foundBaseLayer.url}
          className={`absolute inset-0 w-full h-full ${videoFitClass}`}
          style={{ zIndex: 1 }}
          playsInline
          preload="auto"
          onLoadedData={handleLoaded}
        />
      )}

      {/* Render overlay layers (V2+, images, captions) */}
      {overlayLayers.map((layer, index) => {
        const isOverlay = layer.trackId !== 'V1';
        const isDragging = draggingLayer === layer.id;
        const isSelected = selectedLayerId === layer.id;
        const styles = getTransformStyles(layer.transform, index + 2, isDragging);

        if (layer.type === 'video') {
          return (
            <video
              key={`${layer.id}-${layer.url}`}
              ref={(el) => {
                if (el) {
                  overlayVideoRefs.current.set(layer.id, el);
                } else {
                  overlayVideoRefs.current.delete(layer.id);
                }
              }}
              src={layer.url}
              className={`absolute inset-0 w-full h-full ${videoFitClass} cursor-grab active:cursor-grabbing ${
                isSelected ? 'ring-2 ring-orange-500 ring-offset-2 ring-offset-black' : ''
              }`}
              style={styles}
              playsInline
              preload="auto"
              muted
              onLoadedData={(e) => {
                // Seek to correct time when loaded
                const video = e.currentTarget;
                if (layer.clipTime !== undefined) {
                  video.currentTime = layer.clipTime;
                }
                // Auto-play if timeline is playing
                if (isPlaying) {
                  video.play().catch(() => {});
                }
              }}
              onMouseDown={(e) => handleLayerMouseDown(e, layer)}
            />
          );
        }

        if (layer.type === 'image') {
          // For overlay images (V2, V3), use explicit sizing instead of fill-then-scale
          if (isOverlay) {
            const scale = layer.transform?.scale || 0.2;
            const xOffset = layer.transform?.x || 0;
            const yOffset = layer.transform?.y || 0;
            const baseZIndex = (styles.zIndex as number) || 0;

            return (
              <div
                key={layer.id}
                className="absolute cursor-grab active:cursor-grabbing"
                style={{
                  width: `${scale * 100}%`,
                  top: `calc(70% + ${yOffset}px)`,
                  left: `calc(50% + ${xOffset}px)`,
                  transform: 'translateX(-50%)',
                  zIndex: baseZIndex + 100,
                  opacity: layer.transform?.opacity ?? 1,
                }}
                onMouseDown={(e) => handleLayerMouseDown(e, layer)}
              >
                <img
                  src={layer.url}
                  alt="Layer"
                  className="w-full h-auto rounded-lg shadow-lg pointer-events-none"
                  draggable={false}
                />
                {/* Selection indicator */}
                {isSelected && (
                  <div className="absolute inset-0 ring-2 ring-orange-500 rounded-lg pointer-events-none" />
                )}
                {/* Drag handle indicator */}
                {!isDragging && (
                  <div className="absolute top-2 right-2 p-1.5 bg-black/60 rounded text-white/70 pointer-events-none">
                    <Move className="w-3 h-3" />
                  </div>
                )}
              </div>
            );
          }

          // For V1 images (full background), use the original fill approach
          return (
            <div
              key={layer.id}
              className="absolute inset-0 w-full h-full"
              style={{ ...styles, pointerEvents: 'none' }}
            >
              <img
                src={layer.url}
                alt="Layer"
                className="w-full h-full object-contain pointer-events-none"
                draggable={false}
              />
            </div>
          );
        }

        if (layer.type === 'caption' && layer.captionWords && layer.captionStyle) {
          return (
            <CaptionRenderer
              key={layer.id}
              words={layer.captionWords}
              style={layer.captionStyle}
              currentTime={layer.clipTime}
            />
          );
        }

        // Audio layers - invisible but play audio synced to timeline
        if (layer.type === 'audio') {
          return (
            <audio
              key={`audio-${layer.id}`}
              ref={(el) => {
                if (el) {
                  overlayVideoRefs.current.set(layer.id, el as unknown as HTMLVideoElement);
                } else {
                  overlayVideoRefs.current.delete(layer.id);
                }
              }}
              src={layer.url}
              preload="auto"
              onLoadedData={(e) => {
                const audio = e.currentTarget;
                if (layer.clipTime !== undefined) {
                  audio.currentTime = layer.clipTime;
                }
                if (isPlaying) {
                  audio.play().catch(() => {});
                }
              }}
              style={{ display: 'none' }}
            />
          );
        }

        return null;
      })}

      {/* Frame Template Overlays (logos, text) */}
      {isVerticalWithFrame && frameTemplate.overlays
        .filter((overlay) => {
          // Filter overlays based on current time
          const start = overlay.startTime ?? 0;
          const end = overlay.endTime ?? projectDuration;
          return currentTime >= start && currentTime <= end;
        })
        .map((overlay) => {
        // Calculate position based on zone
        // Top zone: top 20% of frame, Bottom zone: bottom 20% of frame
        const zoneTop = overlay.zone === 'top' ? '0%' : '80%';
        const zoneHeight = '20%';

        // Position within zone (x is 0-100 across width, y is 0-100 within zone height)
        const leftPercent = overlay.x;
        const topWithinZone = overlay.y;

        if (overlay.type === 'logo' && overlay.assetId) {
          const logoUrl = getAssetUrl(overlay.assetId);
          console.log('[VideoPreview] Logo overlay:', overlay.id, 'assetId:', overlay.assetId, 'url:', logoUrl);
          if (!logoUrl) {
            console.warn('[VideoPreview] No URL found for logo overlay:', overlay.id);
            return null;
          }

          // Calculate scale - use container width percentage via CSS
          const scalePercent = (overlay.scale || 0.3) * 100;

          return (
            <div
              key={`${overlay.id}-${overlay.zone}-${overlay.x}-${overlay.y}`}
              className="absolute pointer-events-none"
              style={{
                // Position based on zone + Y offset within zone
                top: `calc(${zoneTop} + ${zoneHeight} * ${topWithinZone / 100})`,
                left: `${leftPercent}%`,
                transform: 'translate(-50%, -50%)',
                zIndex: 200,
                // Set width relative to container for proper img sizing
                width: `${scalePercent}%`,
                maxWidth: '80%',
              }}
            >
              <img
                src={logoUrl}
                alt="Logo overlay"
                crossOrigin="anonymous"
                onError={(e) => console.error('[VideoPreview] Logo image failed to load:', logoUrl, e)}
                onLoad={() => console.log('[VideoPreview] Logo image loaded successfully:', logoUrl)}
                style={{
                  width: '100%',
                  height: 'auto',
                  opacity: overlay.opacity ?? 1,
                  objectFit: 'contain',
                }}
              />
            </div>
          );
        }

        if (overlay.type === 'text' && overlay.text) {
          return (
            <div
              key={`${overlay.id}-text-${overlay.color}-${overlay.fontSize}-${overlay.text}`}
              className="absolute pointer-events-none"
              style={{
                top: `calc(${zoneTop} + ${zoneHeight} * ${topWithinZone / 100})`,
                left: `${leftPercent}%`,
                transform: 'translate(-50%, -50%)',
                zIndex: 200,
              }}
            >
              <span
                style={{
                  fontFamily: overlay.fontFamily || 'Inter',
                  fontSize: `${overlay.fontSize || 32}px`,
                  fontWeight: overlay.fontWeight || 'bold',
                  color: overlay.color || '#ffffff',
                  textShadow: '0 2px 4px rgba(0,0,0,0.5)',
                  whiteSpace: 'nowrap',
                }}
              >
                {overlay.text}
              </span>
            </div>
          );
        }

        if (overlay.type === 'video' && overlay.assetId) {
          const videoUrl = getAssetUrl(overlay.assetId);
          if (!videoUrl) return null;

          // Calculate scale - use container width percentage via CSS
          const scalePercent = (overlay.scale || 0.4) * 100;

          return (
            <div
              key={`${overlay.id}-${overlay.zone}-${overlay.x}-${overlay.y}`}
              className="absolute pointer-events-none"
              style={{
                top: `calc(${zoneTop} + ${zoneHeight} * ${topWithinZone / 100})`,
                left: `${leftPercent}%`,
                transform: 'translate(-50%, -50%)',
                zIndex: 200,
                // Set width relative to container for proper video sizing
                width: `${scalePercent}%`,
                maxWidth: '80%',
              }}
            >
              <video
                src={videoUrl}
                autoPlay
                muted
                loop={overlay.loop ?? true}
                playsInline
                style={{
                  width: '100%',
                  height: 'auto',
                  opacity: overlay.opacity ?? 1,
                  objectFit: 'contain',
                }}
              />
            </div>
          );
        }

        return null;
      })}

      {/* Layer count indicator */}
      {layers.length > 1 && (
        <div className="absolute top-3 left-3 text-xs text-white/60 bg-black/50 px-2 py-1 rounded flex items-center gap-1 z-50">
          <Layers className="w-3 h-3" />
          <span>{layers.length} layers</span>
        </div>
      )}

      {/* Type indicator */}
      <div className="absolute bottom-3 right-3 text-xs text-white/60 bg-black/50 px-2 py-1 rounded flex items-center gap-1 z-50">
        {baseVideoLayer ? <Play className="w-3 h-3" /> : <ImageIcon className="w-3 h-3" />}
        <span>{baseVideoLayer ? 'video' : layers[0]?.type}</span>
      </div>

      {/* Dragging indicator */}
      {draggingLayer && (
        <div className="absolute bottom-3 left-3 text-xs text-orange-400 bg-black/70 px-2 py-1 rounded z-50">
          Dragging...
        </div>
      )}
    </div>
  );
});

export default VideoPreview;
