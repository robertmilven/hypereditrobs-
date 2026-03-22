import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import VideoPreview, { VideoPreviewHandle } from '@/react-app/components/VideoPreview';
import Timeline from '@/react-app/components/Timeline';
import AssetLibrary from '@/react-app/components/AssetLibrary';
import ClipPropertiesPanel from '@/react-app/components/ClipPropertiesPanel';
import CaptionPropertiesPanel from '@/react-app/components/CaptionPropertiesPanel';
import AIPromptPanel from '@/react-app/components/AIPromptPanel';
import GifSearchPanel from '@/react-app/components/GifSearchPanel';
import ResizablePanel from '@/react-app/components/ResizablePanel';
import ResizableVerticalPanel from '@/react-app/components/ResizableVerticalPanel';
import TimelineTabs from '@/react-app/components/TimelineTabs';
import { useProject, Asset, TimelineClip, CaptionStyle } from '@/react-app/hooks/useProject';
import { useVideoSession } from '@/react-app/hooks/useVideoSession';
import { Sparkles, ListOrdered, Copy, Check, X, Download, Play, Palette, Film, HelpCircle, Layers, Loader2 } from 'lucide-react';
import KeyboardShortcuts from '@/react-app/components/KeyboardShortcuts';
import ProjectTemplates from '@/react-app/components/ProjectTemplates';
import FrameTemplatePanel from '@/react-app/components/FrameTemplatePanel';
import FrameTemplateSelector from '@/react-app/components/FrameTemplateSelector';
import { useFrameTemplates, createBlankTemplate } from '@/react-app/hooks/useFrameTemplates';
import { useOverlayAssets } from '@/react-app/hooks/useOverlayAssets';
import { useSceneDetection } from '@/react-app/hooks/useSceneDetection';
import SceneDetectionPanel from '@/react-app/components/SceneDetectionPanel';
import { useThumbnailGenerator } from '@/react-app/hooks/useThumbnailGenerator';
import ThumbnailGeneratorPanel from '@/react-app/components/ThumbnailGeneratorPanel';
import { useBrollSuggestions } from '@/react-app/hooks/useBrollSuggestions';
import BrollSuggestionsPanel from '@/react-app/components/BrollSuggestionsPanel';
import { useViralEdit } from '@/react-app/hooks/useViralEdit';
import ViralEditPanel from '@/react-app/components/ViralEditPanel';
import { useContentRepurpose } from '@/react-app/hooks/useContentRepurpose';
import ContentRepurposePanel from '@/react-app/components/ContentRepurposePanel';
import RemotionGeneratorPanel from '@/react-app/components/RemotionGeneratorPanel';
import AIToolsDropdown from '@/react-app/components/AIToolsDropdown';
import CommandBar from '@/react-app/components/CommandBar';
import ExportPresetsDropdown, { type ExportPreset } from '@/react-app/components/ExportPresetsDropdown';
import { Image, Camera, Zap, Scissors, Code } from 'lucide-react';
import type { FrameTemplate } from '@/react-app/hooks/useProject';
import type { TemplateId } from '@/remotion/templates';

interface ChapterData {
  chapters: Array<{ start: number; title: string }>;
  youtubeFormat: string;
  summary: string;
}

export default function Home() {
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [chapterData, setChapterData] = useState<ChapterData | null>(null);
  const [showChapters, setShowChapters] = useState(false);
  const [isGeneratingChapters, setIsGeneratingChapters] = useState(false);
  const [copied, setCopied] = useState(false);
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '9:16'>('16:9');
  const [autoSnap, setAutoSnap] = useState(true); // Ripple delete mode - shift clips when deleting
  const [showGifSearch, setShowGifSearch] = useState(false);
  const [showKeyboardShortcuts, setShowKeyboardShortcuts] = useState(false);
  const [showScenePanel, setShowScenePanel] = useState(false);
  const [showThumbnailPanel, setShowThumbnailPanel] = useState(false);
  const [showBrollPanel, setShowBrollPanel] = useState(false);
  const [showViralPanel, setShowViralPanel] = useState(false);
  const [showRepurposePanel, setShowRepurposePanel] = useState(false);
  const [showRemotionPanel, setShowRemotionPanel] = useState(false);
  const [showCommandBar, setShowCommandBar] = useState(false);

  // Frame template for 9:16 vertical video styling
  const { templates: frameTemplates, saveTemplate: saveFrameTemplate, deleteTemplate: deleteFrameTemplate } = useFrameTemplates();
  const [currentFrameTemplate, setCurrentFrameTemplate] = useState<FrameTemplate>(() => createBlankTemplate());

  const videoPreviewRef = useRef<VideoPreviewHandle>(null);
  const playbackRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);

  // Use the new project hook for multi-asset management
  const {
    session,
    assets,
    tracks,
    clips,
    loading,
    status,
    checkServer,
    uploadAsset,
    deleteAsset,
    getAssetStreamUrl,
    refreshAssets,
    addClip,
    updateClip,
    deleteClip,
    undoWorkflowClips,
    moveClip,
    splitClip,
    saveProject,
    saveProjectNow,
    loadProject,
    renderProject,
    getDuration,
    // Captions
    addCaptionClipsBatch,
    clearCaptionClips,
    updateCaptionStyle,
    updateCaptionWords,
    getCaptionData,
    captionData,
    // Timeline tabs
    timelineTabs,
    activeTabId,
    createTimelineTab,
    switchTimelineTab,
    closeTimelineTab,
    updateTabClips,
    updateTabAsset,
    // Settings
    settings,
    setSettings,
    setClips,
  } = useProject();

  // Overlay assets for frame templates - shared state passed to both FrameTemplatePanel and VideoPreview
  const {
    overlayAssets,
    uploading: overlayUploading,
    uploadOverlayAsset,
    deleteOverlayAsset,
  } = useOverlayAssets(session?.sessionId);

  // Smart Scene Detection
  const {
    scenes,
    loading: scenesLoading,
    error: scenesError,
    analyzedAssetId,
    detectScenes,
    toggleSceneSelection,
    selectAll: selectAllScenes,
    updateSceneBoundary,
    mergeScenes,
    splitScene: splitDetectedScene,
    clearScenes,
    selectedScenes,
  } = useSceneDetection(session?.sessionId);

  // AI Thumbnail Generator
  const thumbnailGenerator = useThumbnailGenerator(session?.sessionId);

  // B-Roll Suggestions
  const brollSuggestions = useBrollSuggestions(session?.sessionId);

  // Viral Edit
  const viralEdit = useViralEdit(session?.sessionId);

  // Content Repurposing (Long to Shorts)
  const contentRepurpose = useContentRepurpose(session?.sessionId);

  // Global undo stack (snapshot of clips array before destructive operations)
  const undoStackRef = useRef<import('@/react-app/hooks/useProject').TimelineClip[][]>([]);
  const handleGlobalUndo = useCallback(() => {
    const prev = undoStackRef.current.pop();
    if (prev) setClips(prev);
  }, [setClips]);

  // Compute the active clips based on which tab is selected
  const activeClips = useMemo(() => {
    if (activeTabId === 'main') {
      return clips;
    }
    const activeTab = timelineTabs.find(tab => tab.id === activeTabId);
    return activeTab?.clips || [];
  }, [activeTabId, clips, timelineTabs]);

  // Use the legacy session hook for AI editing (single video operations)
  const {
    session: legacySession,
    processing: legacyProcessing,
    status: legacyStatus,
    generateChapters: legacyGenerateChapters,
  } = useVideoSession();

  // Check server on mount
  useEffect(() => {
    checkServer();
  }, [checkServer]);

  // Load project from server when session becomes available
  useEffect(() => {
    if (session) {
      console.log('Session available, loading project...');
      loadProject();
    }
  }, [session, loadProject]);

  // Command Bar keyboard listener (Cmd+K / Ctrl+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setShowCommandBar(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Get all clips at the current playhead position as layers
  const getPreviewLayers = useCallback(() => {
    // If a specific asset is selected for preview (from library), show only that
    if (previewAssetId) {
      const asset = assets.find(a => a.id === previewAssetId);
      // Use asset.streamUrl which has cache-busting timestamp
      const url = asset?.streamUrl || (asset ? getAssetStreamUrl(previewAssetId) : null);
      if (asset && url) {
        return [{
          id: 'preview-' + previewAssetId,
          url,
          type: asset.type,
          trackId: 'V1',
          clipTime: 0,
          clipStart: 0,
        }];
      }
      return [];
    }

    // Find ALL clips at the current playhead position
    const layers: Array<{
      id: string;
      url: string;
      type: 'video' | 'image' | 'audio' | 'caption';
      trackId: string;
      clipTime: number;
      clipStart: number;
      transform?: TimelineClip['transform'];
      captionWords?: Array<{ text: string; start: number; end: number }>;
      captionStyle?: CaptionStyle;
    }> = [];

    // Check video tracks (V1, V2, V3...)
    const videoTracks = ['V1', 'V2', 'V3'];

    for (const trackId of videoTracks) {
      const clipsOnTrack = activeClips.filter(c =>
        c.trackId === trackId &&
        currentTime >= c.start &&
        currentTime < c.start + c.duration
      );

      for (const clip of clipsOnTrack) {
        const asset = assets.find(a => a.id === clip.assetId);
        // Use asset.streamUrl which has cache-busting timestamp from refreshAssets
        const url = asset?.streamUrl || (asset ? getAssetStreamUrl(asset.id) : null);
        if (asset && url) {
          // Calculate the time within the clip (accounting for in-point)
          const clipTime = (currentTime - clip.start) + (clip.inPoint || 0);
          layers.push({
            id: clip.id,
            url,
            type: asset.type,
            trackId: clip.trackId,
            clipTime,
            clipStart: clip.start,
            transform: clip.transform,
          });
        }
      }
    }

    // Check audio tracks (A1, A2)
    const audioTracks = ['A1', 'A2'];

    for (const trackId of audioTracks) {
      const clipsOnTrack = activeClips.filter(c =>
        c.trackId === trackId &&
        currentTime >= c.start &&
        currentTime < c.start + c.duration
      );

      for (const clip of clipsOnTrack) {
        const asset = assets.find(a => a.id === clip.assetId);
        const url = asset?.streamUrl || (asset ? getAssetStreamUrl(asset.id) : null);
        if (asset && url && asset.type === 'audio') {
          const clipTime = (currentTime - clip.start) + (clip.inPoint || 0);
          layers.push({
            id: clip.id,
            url,
            type: 'audio',
            trackId: clip.trackId,
            clipTime,
            clipStart: clip.start,
          });
        }
      }
    }

    // Check caption track (T1)
    const captionClips = activeClips.filter(c =>
      c.trackId === 'T1' &&
      currentTime >= c.start &&
      currentTime < c.start + c.duration
    );

    for (const clip of captionClips) {
      const caption = getCaptionData(clip.id);
      if (caption) {
        // Words have relative timestamps (0 to chunk duration), so pass clip-relative time
        layers.push({
          id: clip.id,
          url: '',
          type: 'caption',
          trackId: clip.trackId,
          clipTime: currentTime - clip.start, // Convert to clip-relative time
          clipStart: clip.start,
          captionWords: caption.words,
          captionStyle: caption.style,
        });
      }
    }

    return layers;
  }, [previewAssetId, assets, activeClips, currentTime, getAssetStreamUrl, getCaptionData]);

  const previewLayers = getPreviewLayers();
  const hasPreviewContent = previewLayers.length > 0;

  // Get duration based on active tab's clips
  const duration = useMemo(() => {
    if (activeClips.length === 0) return 0;
    return Math.max(...activeClips.map(c => c.start + c.duration));
  }, [activeClips]);

  // Timeline playback effect
  useEffect(() => {
    if (isPlaying && duration > 0) {
      lastTimeRef.current = performance.now();

      const animate = (now: number) => {
        const delta = (now - lastTimeRef.current) / 1000; // Convert to seconds
        lastTimeRef.current = now;

        setCurrentTime(prev => {
          const newTime = prev + delta;
          if (newTime >= duration) {
            setIsPlaying(false);
            return duration;
          }
          return newTime;
        });

        playbackRef.current = requestAnimationFrame(animate);
      };

      playbackRef.current = requestAnimationFrame(animate);

      return () => {
        if (playbackRef.current) {
          cancelAnimationFrame(playbackRef.current);
        }
      };
    }
  }, [isPlaying, duration]);

  // Handle play/pause
  const handlePlayPause = useCallback(() => {
    if (currentTime >= duration && duration > 0) {
      // If at end, restart from beginning
      setCurrentTime(0);
    }
    setIsPlaying(prev => !prev);
  }, [currentTime, duration]);

  // Handle stop (go to beginning)
  const handleStop = useCallback(() => {
    setIsPlaying(false);
    setCurrentTime(0);
  }, []);

  // Handle timeline seeking
  const handleTimelineSeek = useCallback((time: number) => {
    setCurrentTime(time);
    // Don't seek the video directly - let the clipTime prop handle it
  }, []);


  // Handle asset upload
  const handleAssetUpload = useCallback(async (files: FileList) => {
    for (const file of Array.from(files)) {
      try {
        const newAsset = await uploadAsset(file);

        // Auto-detect aspect ratio from video dimensions
        if (newAsset && newAsset.type === 'video' && newAsset.width && newAsset.height) {
          const isPortrait = newAsset.height > newAsset.width;
          setAspectRatio(isPortrait ? '9:16' : '16:9');
          console.log(`Auto-detected aspect ratio: ${isPortrait ? '9:16 (portrait)' : '16:9 (landscape)'} from ${newAsset.width}x${newAsset.height}`);
        }
      } catch (error) {
        console.error('Upload failed:', error);
        alert(`Upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  }, [uploadAsset]);

  // Handle GIF added from search panel
  const handleGifAdded = useCallback(async () => {
    // Refresh assets to include the newly added GIF
    await refreshAssets();
    setShowGifSearch(false);
  }, [refreshAssets]);

  // Handle drag start from asset library
  const handleAssetDragStart = useCallback((_asset: Asset) => {
    // Asset drag is handled by the browser's native drag-drop
  }, []);

  // Handle asset selection (from library)
  const handleAssetSelect = useCallback((assetId: string | null) => {
    setSelectedAssetId(assetId);
    // When selecting from library, preview that asset
    setPreviewAssetId(assetId);
    // Clear timeline clip selection
    setSelectedClipId(null);
  }, []);

  // Handle dropping asset onto timeline
  const handleDropAsset = useCallback((asset: Asset, trackId: string, time: number) => {
    // Determine which track to use based on asset type
    let targetTrackId = trackId;

    // If dropping audio on video track, redirect to audio track
    if (asset.type === 'audio' && trackId.startsWith('V')) {
      targetTrackId = 'A1';
    }
    // If dropping video/image on audio track, redirect to video track
    if (asset.type !== 'audio' && trackId.startsWith('A')) {
      targetTrackId = 'V1';
    }

    // Images need a default duration (5 seconds) since they don't have inherent duration
    const clipDuration = asset.type === 'image' ? 5 : asset.duration;

    // Check if we're on an edit tab (not main)
    if (activeTabId !== 'main') {
      // Add clip to the edit tab's clips array
      const activeTab = timelineTabs.find(tab => tab.id === activeTabId);
      if (activeTab) {
        const newClip: TimelineClip = {
          id: crypto.randomUUID(),
          assetId: asset.id,
          trackId: targetTrackId,
          start: time,
          duration: clipDuration || 5,
          inPoint: 0,
          outPoint: clipDuration || 5,
        };
        updateTabClips(activeTabId, [...activeTab.clips, newClip]);
        console.log('Added clip to edit tab:', activeTabId, newClip);
      }
    } else {
      // Add clip to main timeline
      addClip(asset.id, targetTrackId, time, clipDuration);
    }
    saveProject();
  }, [addClip, saveProject, activeTabId, timelineTabs, updateTabClips]);

  // Handle moving clip
  const handleMoveClip = useCallback((clipId: string, newStart: number, newTrackId?: string) => {
    // Check if we're on an edit tab
    if (activeTabId !== 'main') {
      const activeTab = timelineTabs.find(tab => tab.id === activeTabId);
      if (activeTab) {
        const updatedClips = activeTab.clips.map(clip => {
          if (clip.id === clipId) {
            return {
              ...clip,
              start: newStart,
              trackId: newTrackId || clip.trackId,
            };
          }
          return clip;
        });
        updateTabClips(activeTabId, updatedClips);
      }
    } else {
      moveClip(clipId, newStart, newTrackId);
    }
  }, [moveClip, activeTabId, timelineTabs, updateTabClips]);

  // Handle resizing clip
  const handleResizeClip = useCallback((clipId: string, newInPoint: number, newOutPoint: number, newStart?: number) => {
    const newDuration = newOutPoint - newInPoint;

    // Check if we're on an edit tab
    if (activeTabId !== 'main') {
      const activeTab = timelineTabs.find(tab => tab.id === activeTabId);
      if (activeTab) {
        const clip = activeTab.clips.find(c => c.id === clipId);
        if (!clip) return;

        const updatedClips = activeTab.clips.map(c => {
          if (c.id === clipId) {
            return {
              ...c,
              inPoint: newInPoint,
              outPoint: newOutPoint,
              duration: newDuration,
              start: newStart ?? c.start,
            };
          }
          return c;
        });
        updateTabClips(activeTabId, updatedClips);
      }
    } else {
      const clip = clips.find(c => c.id === clipId);
      if (!clip) return;

      updateClip(clipId, {
        inPoint: newInPoint,
        outPoint: newOutPoint,
        duration: newDuration,
        start: newStart ?? clip.start,
      });
    }
  }, [clips, updateClip, activeTabId, timelineTabs, updateTabClips]);

  // Handle deleting clip from timeline (with autoSnap/ripple support)
  const handleDeleteClip = useCallback((clipId: string) => {
    // Check if we're on an edit tab
    if (activeTabId !== 'main') {
      const activeTab = timelineTabs.find(tab => tab.id === activeTabId);
      if (activeTab) {
        const updatedClips = activeTab.clips.filter(c => c.id !== clipId);
        updateTabClips(activeTabId, updatedClips);
      }
    } else {
      deleteClip(clipId, autoSnap);
    }

    if (selectedClipId === clipId) {
      setSelectedClipId(null);
    }
  }, [deleteClip, selectedClipId, autoSnap, activeTabId, timelineTabs, updateTabClips]);

  // Delete all caption clips on T1 and immediately persist the change.
  // Uses explicit clips array to avoid stale clipsRef — setClips hasn't committed to ref yet.
  const handleClearAllCaptionClips = useCallback(() => {
    const newClips = clips.filter(c => c.trackId !== 'T1');
    clearCaptionClips();
    saveProjectNow(newClips);
  }, [clips, clearCaptionClips, saveProjectNow]);

  // Handle cutting clips at the playhead position
  const handleCutAtPlayhead = useCallback(() => {
    // Find all clips that are under the playhead
    const clipsAtPlayhead = clips.filter(clip =>
      currentTime > clip.start && currentTime < clip.start + clip.duration
    );

    if (clipsAtPlayhead.length === 0) {
      return; // No clips to cut
    }

    // Split each clip at the playhead
    for (const clip of clipsAtPlayhead) {
      splitClip(clip.id, currentTime);
    }

    saveProject();
  }, [clips, currentTime, splitClip, saveProject]);

  // Split timeline at all detected scene boundaries
  const handleSplitAllScenes = useCallback(async () => {
    if (!session || selectedScenes.length === 0) return;

    // Find the V1 clip(s)
    const v1Clips = clips.filter(c => c.trackId === 'V1');
    if (v1Clips.length === 0) return;

    // Save undo state
    undoStackRef.current.push([...clips]);

    // Sort scenes by start time
    const sortedScenes = [...selectedScenes].sort((a, b) => a.startTime - b.startTime);

    // Split at each scene boundary (except the last scene's end)
    for (let i = 0; i < sortedScenes.length - 1; i++) {
      const sceneEndTime = sortedScenes[i].endTime;

      // Find the clip that contains this scene end
      const clipToSplit = clips.find(c =>
        c.trackId === 'V1' &&
        sceneEndTime > c.start &&
        sceneEndTime < c.start + c.duration
      );

      if (clipToSplit) {
        splitClip(clipToSplit.id, sceneEndTime);
      }
    }

    await saveProject();
  }, [session, selectedScenes, clips, splitClip, saveProject]);

  // Export selected scenes as individual video files
  const handleExportSelectedScenes = useCallback(async () => {
    if (!session || selectedScenes.length === 0 || !analyzedAssetId) return;

    for (const scene of selectedScenes) {
      try {
        const response = await fetch(
          `http://localhost:3333/session/${session.sessionId}/export-scene`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              assetId: analyzedAssetId,
              startTime: scene.startTime,
              endTime: scene.endTime,
              title: scene.title,
            }),
          }
        );

        if (response.ok) {
          const result = await response.json();
          // Trigger download
          const link = document.createElement('a');
          link.href = `http://localhost:3333${result.downloadUrl}`;
          link.download = result.filename;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        }
      } catch (e) {
        console.error('Failed to export scene:', scene.title, e);
      }
    }
  }, [session, selectedScenes, analyzedAssetId]);

  // Handle adding text overlay
  const handleAddText = useCallback(() => {
    // Create a text clip on T1 track at current playhead
    // TODO: Open text editor modal or add default text
    console.log('Add text overlay at', currentTime);
  }, [currentTime]);

  // Handle toggling aspect ratio
  const handleToggleAspectRatio = useCallback(() => {
    setAspectRatio(prev => {
      const newRatio = prev === '16:9' ? '9:16' : '16:9';
      // Update project settings with new dimensions
      const newSettings = newRatio === '9:16'
        ? { width: 1080, height: 1920 }
        : { width: 1920, height: 1080 };

      setSettings(s => ({ ...s, ...newSettings }));
      return newRatio;
    });
  }, [setSettings]);

  // Frame template handlers
  const handleUpdateFrameTemplate = useCallback((updates: Partial<FrameTemplate>) => {
    setCurrentFrameTemplate(prev => ({ ...prev, ...updates }));
  }, []);

  const handleSaveFrameTemplate = useCallback(() => {
    saveFrameTemplate(currentFrameTemplate);
  }, [currentFrameTemplate, saveFrameTemplate]);

  const handleSelectFrameTemplate = useCallback((template: FrameTemplate) => {
    setCurrentFrameTemplate({ ...template, id: `template-${Date.now()}` });
  }, []);

  // Handle updating a single overlay (for timeline drag/resize)
  const handleUpdateOverlay = useCallback((overlayId: string, updates: { startTime?: number; endTime?: number }) => {
    setCurrentFrameTemplate(prev => ({
      ...prev,
      overlays: prev.overlays.map(o =>
        o.id === overlayId ? { ...o, ...updates } : o
      ),
    }));
  }, []);

  // Handle selecting clip
  const handleSelectClip = useCallback((clipId: string | null) => {
    setSelectedClipId(clipId);
    // Clear asset preview mode - let timeline-based preview take over
    setPreviewAssetId(null);
  }, []);

  // Handle updating clip transform (scale, rotation, crop, etc.)
  const handleUpdateClipTransform = useCallback((clipId: string, transform: TimelineClip['transform']) => {
    updateClip(clipId, { transform });
    saveProject();
  }, [updateClip, saveProject]);

  // Get selected clip and its asset
  const selectedClip = useMemo(() =>
    clips.find(c => c.id === selectedClipId) || null,
    [clips, selectedClipId]
  );

  const selectedClipAsset = useMemo(() =>
    selectedClip ? assets.find(a => a.id === selectedClip.assetId) || null : null,
    [selectedClip, assets]
  );

  // Check if selected clip is a caption
  const selectedCaptionData = useMemo(() =>
    selectedClip && selectedClip.trackId === 'T1' ? getCaptionData(selectedClip.id) : null,
    [selectedClip, getCaptionData]
  );

  // Handle dragging overlay in video preview
  const handleLayerMove = useCallback((layerId: string, x: number, y: number) => {
    const clip = clips.find(c => c.id === layerId);
    if (!clip) return;

    const currentTransform = clip.transform || {};
    updateClip(layerId, {
      transform: { ...currentTransform, x, y }
    });
  }, [clips, updateClip]);

  // Handle selecting layer from video preview
  const handleLayerSelect = useCallback((layerId: string) => {
    setSelectedClipId(layerId);
    setPreviewAssetId(null);
  }, []);

  // Handle AI edit (using FFmpeg on video assets)
  const handleApplyEdit = useCallback(async (command: string) => {
    if (!session?.sessionId) {
      throw new Error('Please upload a video first');
    }

    // Find the video asset to edit - prioritize selected clip's asset, otherwise first video
    let targetAssetId: string | null = null;

    if (selectedClipId) {
      const selectedClip = clips.find(c => c.id === selectedClipId);
      if (selectedClip) {
        const asset = assets.find(a => a.id === selectedClip.assetId);
        if (asset?.type === 'video') {
          targetAssetId = asset.id;
        }
      }
    }

    if (!targetAssetId) {
      const videoAsset = assets.find(a => a.type === 'video');
      if (!videoAsset) {
        throw new Error('Please upload a video first');
      }
      targetAssetId = videoAsset.id;
    }

    console.log('Applying FFmpeg edit to asset:', targetAssetId);
    console.log('Command:', command);

    // Call the server to process the video with FFmpeg
    const response = await fetch(`http://localhost:3333/session/${session.sessionId}/process-asset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assetId: targetAssetId,
        command,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to apply edit');
    }

    const result = await response.json();
    console.log('Edit applied in-place, assetId:', result.assetId);

    // Process-asset edits the file in-place (same assetId).
    // refreshAssets() cache-busts the stream URL so VideoPreview reloads automatically.
    await refreshAssets();
  }, [session, assets, clips, selectedClipId, refreshAssets]);

  // Handle chapter generation - works with both legacy and new session systems
  const handleGenerateChapters = useCallback(async () => {
    setIsGeneratingChapters(true);

    // Try legacy session first
    if (legacySession) {
      try {
        const result = await legacyGenerateChapters();
        setChapterData(result);
        setShowChapters(true);
      } catch (error) {
        console.error('Chapter generation failed:', error);
        alert(`Failed to generate chapters: ${error instanceof Error ? error.message : 'Unknown error'}`);
      } finally {
        setIsGeneratingChapters(false);
      }
      return;
    }

    // Try new session system
    if (session?.sessionId) {
      const videoAsset = assets.find(a => a.type === 'video');
      if (!videoAsset) {
        alert('Please add a video to the timeline first');
        setIsGeneratingChapters(false);
        return;
      }

      try {
        // Build transcript from caption data if available
        let transcript = '';
        const captionClips = clips.filter(c => c.trackId.startsWith('T'));
        for (const clip of captionClips) {
          const cd = captionData[clip.id];
          if (cd?.words) {
            transcript += cd.words.map(w => `[${w.start.toFixed(2)}] ${w.text}`).join('\n') + '\n';
          }
        }

        const response = await fetch(`http://localhost:3333/session/${session.sessionId}/chapters`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(transcript ? { transcript } : {}),
        });

        if (!response.ok) {
          throw new Error(`Server error: ${response.status}`);
        }

        const result = await response.json();
        setChapterData(result);
        setShowChapters(true);
      } catch (error) {
        console.error('Chapter generation failed:', error);
        alert(`Failed to generate chapters: ${error instanceof Error ? error.message : 'Unknown error'}`);
      } finally {
        setIsGeneratingChapters(false);
      }
      return;
    }

    alert('Please upload a video first');
    setIsGeneratingChapters(false);
  }, [legacySession, legacyGenerateChapters, session, assets, clips, captionData]);

  // Copy chapters to clipboard
  const handleCopyChapters = useCallback(() => {
    if (chapterData?.youtubeFormat) {
      navigator.clipboard.writeText(chapterData.youtubeFormat);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [chapterData]);

  // Generate chapters and make cuts at each chapter point
  const handleChapterCuts = useCallback(async (): Promise<{
    chapters: Array<{ start: number; title: string }>;
    cutsApplied: number;
    youtubeFormat: string;
  }> => {
    if (!session) {
      throw new Error('No session available');
    }

    // Check if we have a video asset on V1
    const v1Clip = clips.find(c => c.trackId === 'V1');
    if (!v1Clip) {
      throw new Error('No video clip on V1 track. Please add a video to the timeline first.');
    }

    console.log('Generating chapters and making cuts...');

    // Build pre-built transcript from existing captionData if available (skips Whisper on server)
    let preBuiltTranscript: string | null = null;
    const t1Clips = clips.filter(c => c.trackId === 'T1').sort((a, b) => a.start - b.start);
    if (t1Clips.length > 0 && Object.keys(captionData).length > 0) {
      const parts: string[] = [];
      for (const clip of t1Clips) {
        const cd = captionData[clip.id];
        if (!cd?.words?.length) continue;
        for (const word of cd.words) {
          parts.push(`[${(clip.start + word.start).toFixed(1)}s] ${word.text}`);
        }
      }
      if (parts.length > 10) {
        preBuiltTranscript = parts.join(' ');
        console.log(`Smart chapters: using ${parts.length} caption words instead of re-transcribing`);
      }
    }

    // Generate chapters using the session API
    const response = await fetch(`http://localhost:3333/session/${session.sessionId}/chapters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(preBuiltTranscript ? { transcript: preBuiltTranscript } : {}),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to generate chapters');
    }

    const result = await response.json();
    const chapters: Array<{ start: number; title: string }> = result.chapters || [];

    if (chapters.length === 0) {
      throw new Error('No chapters were detected in the video');
    }

    console.log(`Generated ${chapters.length} chapters:`, chapters);

    // Store chapter data for the modal
    setChapterData(result);

    // Get chapter timestamps to cut at (skip first chapter at 0:00)
    const cutTimestamps = chapters
      .filter(ch => ch.start >= 0.5)
      .map(ch => ch.start)
      .sort((a, b) => a - b);

    console.log('Cut timestamps:', cutTimestamps);

    // Get current project state from server
    const projectResponse = await fetch(`http://localhost:3333/session/${session.sessionId}/project`);
    const projectData = await projectResponse.json();
    let currentClips: TimelineClip[] = projectData.clips || [];

    // Process all cuts by directly manipulating the clips array
    // This avoids React state batching issues
    let cutsApplied = 0;

    for (const timestamp of cutTimestamps) {
      // Find clip that spans this timestamp on V1
      const clipIndex = currentClips.findIndex((clip: TimelineClip) =>
        clip.trackId === 'V1' &&
        timestamp > clip.start &&
        timestamp < clip.start + clip.duration
      );

      if (clipIndex === -1) continue;

      const clip = currentClips[clipIndex];
      const timeInClip = timestamp - clip.start;

      // Skip if too close to edges
      if (timeInClip <= 0.05 || timeInClip >= clip.duration - 0.05) continue;

      const splitInPoint = clip.inPoint + timeInClip;

      // Create the second clip (after the split)
      const secondClip: TimelineClip = {
        id: crypto.randomUUID(),
        assetId: clip.assetId,
        trackId: clip.trackId,
        start: timestamp,
        duration: clip.duration - timeInClip,
        inPoint: splitInPoint,
        outPoint: clip.outPoint,
        transform: clip.transform ? { ...clip.transform } : undefined,
      };

      // Update the first clip (shorten it)
      currentClips[clipIndex] = {
        ...clip,
        duration: timeInClip,
        outPoint: splitInPoint,
      };

      // Add the second clip
      currentClips.push(secondClip);
      cutsApplied++;

      console.log(`Cut at ${timestamp}s: clip ${clip.id} -> new clip ${secondClip.id}`);
    }

    // Save the modified clips directly to server
    if (cutsApplied > 0) {
      await fetch(`http://localhost:3333/session/${session.sessionId}/project`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...projectData, clips: currentClips }),
      });

      // Reload to sync local state
      await loadProject();
    }

    return {
      chapters,
      cutsApplied,
      youtubeFormat: result.youtubeFormat || '',
    };
  }, [session, clips, captionData, loadProject]);

  // Handle scene detection — returns timestamps of scene changes
  const handleSceneDetect = useCallback(async (): Promise<{ scenes: Array<{ timestamp: number }> }> => {
    if (!session) throw new Error('No session available');
    const v1Clip = clips.find(c => c.trackId === 'V1');
    if (!v1Clip) throw new Error('No video on V1 track. Please add a video to the timeline first.');

    const response = await fetch(`http://localhost:3333/session/${session.sessionId}/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'scene-detect' }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Scene detection failed');
    }

    const data = await response.json();
    return { scenes: data.scenes || [] };
  }, [session, clips]);

  // Apply scene cuts — splits V1 clip at each scene timestamp
  const handleApplySceneCuts = useCallback(async (timestamps: number[]): Promise<{ cutsApplied: number }> => {
    if (!session) throw new Error('No session available');

    const sortedTimestamps = [...timestamps].sort((a, b) => a - b);

    const projectResponse = await fetch(`http://localhost:3333/session/${session.sessionId}/project`);
    const projectData = await projectResponse.json();
    let currentClips: TimelineClip[] = projectData.clips || [];

    let cutsApplied = 0;
    for (const timestamp of sortedTimestamps) {
      const clipIndex = currentClips.findIndex((clip: TimelineClip) =>
        clip.trackId === 'V1' &&
        timestamp > clip.start &&
        timestamp < clip.start + clip.duration
      );
      if (clipIndex === -1) continue;

      const clip = currentClips[clipIndex];
      const timeInClip = timestamp - clip.start;
      if (timeInClip <= 0.05 || timeInClip >= clip.duration - 0.05) continue;

      const splitInPoint = clip.inPoint + timeInClip;
      const secondClip: TimelineClip = {
        id: crypto.randomUUID(),
        assetId: clip.assetId,
        trackId: clip.trackId,
        start: timestamp,
        duration: clip.duration - timeInClip,
        inPoint: splitInPoint,
        outPoint: clip.outPoint,
        transform: clip.transform ? { ...clip.transform } : undefined,
      };
      currentClips[clipIndex] = { ...clip, duration: timeInClip, outPoint: splitInPoint };
      currentClips.push(secondClip);
      cutsApplied++;
    }

    if (cutsApplied > 0) {
      await fetch(`http://localhost:3333/session/${session.sessionId}/project`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...projectData, clips: currentClips }),
      });
      await loadProject();
    }

    return { cutsApplied };
  }, [session, clips, loadProject]);

  // Mute filler words in the V1 video using caption word timestamps
  const handleMuteFillerWords = useCallback(async (fillerWords: Set<string>): Promise<{ mutedCount: number }> => {
    if (!session) throw new Error('No session available');

    const v1Clip = clips.find(c => c.trackId === 'V1');
    if (!v1Clip) throw new Error('No video on V1 track.');

    // Gather filler word time segments from captionData with small padding
    const PAD = 0.05;
    const segments: Array<{ start: number; end: number }> = [];
    const t1Clips = clips.filter(c => c.trackId === 'T1').sort((a, b) => a.start - b.start);
    for (const clip of t1Clips) {
      const cd = captionData[clip.id];
      if (!cd?.words?.length) continue;
      for (const word of cd.words) {
        if (fillerWords.has(word.text.toLowerCase().replace(/[^a-z\-]/g, ''))) {
          // Timestamps in captionData are relative to clip start; convert to absolute
          segments.push({
            start: Math.max(0, clip.start + word.start - PAD),
            end: clip.start + word.end + PAD,
          });
        }
      }
    }

    if (segments.length === 0) throw new Error('No filler words found in caption data.');

    const videoAsset = assets.find(a => a.id === v1Clip.assetId);
    const response = await fetch(`http://localhost:3333/session/${session.sessionId}/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'mute-segments', segments, assetId: videoAsset?.id }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Mute segments failed');
    }

    await refreshAssets();
    return { mutedCount: segments.length };
  }, [session, clips, captionData, assets, refreshAssets]);

  // Resequence sections via Gemini + caption transcript
  const handleResequence = useCallback(async (instruction: string): Promise<{
    swaps: Array<{ from: { startTime: number; endTime: number; label: string }; to: { startTime: number; endTime: number; label: string } }>;
    explanation: string;
  }> => {
    if (!session) throw new Error('No session available');

    // Build transcript from captionData
    const t1Clips = clips.filter(c => c.trackId === 'T1').sort((a, b) => a.start - b.start);
    if (t1Clips.length === 0 || Object.keys(captionData).length === 0) {
      throw new Error('No captions found. Add captions first so I can identify sections.');
    }

    const parts: string[] = [];
    for (const clip of t1Clips) {
      const cd = captionData[clip.id];
      if (!cd?.words?.length) continue;
      for (const word of cd.words) {
        parts.push(`[${(clip.start + word.start).toFixed(1)}s] ${word.text}`);
      }
    }
    const transcript = parts.join(' ');

    const response = await fetch(`http://localhost:3333/session/${session.sessionId}/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'resequence', instruction, transcript }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Resequence failed');
    }

    return response.json();
  }, [session, clips, captionData]);

  // Apply a resequence plan: move V1 clips so "from" section lands before "to"
  const handleApplyResequence = useCallback(async (
    swaps: Array<{ from: { startTime: number; endTime: number }; to: { startTime: number; endTime: number } }>
  ): Promise<{ applied: boolean }> => {
    if (!session) throw new Error('No session available');

    const projectResponse = await fetch(`http://localhost:3333/session/${session.sessionId}/project`);
    const projectData = await projectResponse.json();
    let currentClips: TimelineClip[] = projectData.clips || [];

    for (const swap of swaps) {
      // Find V1 clips in the "from" range
      const fromClips = currentClips.filter(c =>
        c.trackId === 'V1' &&
        c.start >= swap.from.startTime - 0.1 &&
        c.start + c.duration <= swap.to.endTime + 0.1 &&
        c.start < swap.from.endTime
      );
      // Find V1 clips in the "to" range
      const toClips = currentClips.filter(c =>
        c.trackId === 'V1' &&
        c.start >= swap.to.startTime - 0.1 &&
        c.start + c.duration <= swap.to.endTime + 0.1 &&
        c.start < swap.to.endTime
      );

      if (fromClips.length === 0 || toClips.length === 0) continue;

      // Swap their start positions (offset within each group preserved)
      const fromBase = Math.min(...fromClips.map(c => c.start));
      const toBase = Math.min(...toClips.map(c => c.start));
      const fromDuration = swap.from.endTime - swap.from.startTime;
      const toDuration = swap.to.endTime - swap.to.startTime;

      for (const clip of fromClips) {
        const offset = clip.start - fromBase;
        const idx = currentClips.findIndex(c => c.id === clip.id);
        currentClips[idx] = { ...clip, start: toBase + offset };
      }
      for (const clip of toClips) {
        const offset = clip.start - toBase;
        const idx = currentClips.findIndex(c => c.id === clip.id);
        currentClips[idx] = { ...clip, start: fromBase + offset + (toDuration - fromDuration) };
      }
    }

    await fetch(`http://localhost:3333/session/${session.sessionId}/project`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...projectData, clips: currentClips }),
    });
    await loadProject();
    return { applied: true };
  }, [session, clips, loadProject]);

  // Feature 1: Auto-Reframe — crop+scale to center subject
  const handleAutoReframe = useCallback(async (assetId?: string): Promise<{ applied: boolean; width: number; height: number }> => {
    if (!session) throw new Error('No session available');
    const videoAsset = assetId ? assets.find(a => a.id === assetId) : assets.find(a => a.type === 'video' && !a.aiGenerated);
    if (!videoAsset) throw new Error('No video asset found');
    const resp = await fetch(`http://localhost:3333/session/${session.sessionId}/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'auto-reframe', assetId: videoAsset.id }),
    });
    if (!resp.ok) { const e = await resp.json(); throw new Error(e.error || 'Auto-reframe failed'); }
    const data = await resp.json();
    await refreshAssets();
    return data;
  }, [session, assets, refreshAssets]);

  // Feature 2: Auto-Duck — duck background music under speech
  const handleAutoDuck = useCallback(async (musicAssetId: string): Promise<{ applied: boolean }> => {
    if (!session) throw new Error('No session available');
    const resp = await fetch(`http://localhost:3333/session/${session.sessionId}/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'auto-duck', musicAssetId }),
    });
    if (!resp.ok) { const e = await resp.json(); throw new Error(e.error || 'Auto-duck failed'); }
    const data = await resp.json();
    await refreshAssets();
    return data;
  }, [session, refreshAssets]);

  // Feature 3: Export SRT — client-side from captionData
  const handleExportSRT = useCallback((): string => {
    const t1Clips = clips.filter(c => c.trackId === 'T1').sort((a, b) => a.start - b.start);
    const lines: string[] = [];
    let idx = 1;
    for (const clip of t1Clips) {
      const cd = captionData[clip.id];
      if (!cd?.words?.length) continue;
      // Group words into chunks (same chunking logic as transcription)
      const words = cd.words;
      let chunkStart = 0;
      while (chunkStart < words.length) {
        let chunkEnd = chunkStart;
        while (chunkEnd + 1 < words.length && chunkEnd - chunkStart < 4 &&
               words[chunkEnd + 1].start - words[chunkEnd].end < 0.7) {
          chunkEnd++;
        }
        const absStart = clip.start + words[chunkStart].start;
        const absEnd = clip.start + words[chunkEnd].end;
        const text = words.slice(chunkStart, chunkEnd + 1).map(w => w.text).join(' ');
        const fmt = (s: number) => {
          const h = Math.floor(s / 3600);
          const m = Math.floor((s % 3600) / 60);
          const sec = Math.floor(s % 60);
          const ms = Math.round((s % 1) * 1000);
          return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
        };
        lines.push(`${idx}\n${fmt(absStart)} --> ${fmt(absEnd)}\n${text}\n`);
        idx++;
        chunkStart = chunkEnd + 1;
      }
    }
    return lines.join('\n');
  }, [clips, captionData]);

  // Feature 5: Silence Preview — return silence info without cutting
  const handleSilencePreview = useCallback(async (): Promise<{
    silences: Array<{ start: number; end: number; duration: number }>;
    totalSilence: number;
    videoDuration: number;
    wouldReduceTo: number;
  }> => {
    if (!session) throw new Error('No session available');
    const videoAsset = assets.find(a => a.type === 'video' && !a.aiGenerated);
    if (!videoAsset) throw new Error('No video asset found');
    const resp = await fetch(`http://localhost:3333/session/${session.sessionId}/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'silence-preview', assetId: videoAsset.id }),
    });
    if (!resp.ok) { const e = await resp.json(); throw new Error(e.error || 'Silence preview failed'); }
    return resp.json();
  }, [session, assets]);

  // Feature 6: Highlight Reel — compile best moments into new asset
  const handleHighlightReel = useCallback(async (durationSecs?: number): Promise<{ assetId: string; duration: number }> => {
    if (!session) throw new Error('No session available');
    const videoAsset = assets.find(a => a.type === 'video' && !a.aiGenerated);
    if (!videoAsset) throw new Error('No video asset found');
    const resp = await fetch(`http://localhost:3333/session/${session.sessionId}/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'highlight-reel', assetId: videoAsset.id, targetDuration: durationSecs ?? 60 }),
    });
    if (!resp.ok) { const e = await resp.json(); throw new Error(e.error || 'Highlight reel failed'); }
    const data = await resp.json();
    await refreshAssets();
    return data;
  }, [session, assets, refreshAssets]);

  // Feature 7: Translate Captions
  const handleTranslateCaptions = useCallback(async (targetLanguage: string): Promise<{ translated: number }> => {
    if (!session) throw new Error('No session available');
    const t1Clips = clips.filter(c => c.trackId === 'T1');
    if (t1Clips.length === 0) throw new Error('No captions found. Add captions first.');
    const results: typeof captionData = {};
    for (const clip of t1Clips) {
      const cd = captionData[clip.id];
      if (!cd?.words?.length) continue;
      const resp = await fetch(`http://localhost:3333/session/${session.sessionId}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'translate-captions', words: cd.words, targetLanguage }),
      });
      if (!resp.ok) { const e = await resp.json(); throw new Error(e.error || 'Translation failed'); }
      const data = await resp.json();
      results[clip.id] = { ...cd, words: data.words };
    }
    for (const [clipId, cd] of Object.entries(results)) {
      updateCaptionWords(clipId, cd.words);
    }
    return { translated: Object.keys(results).length };
  }, [session, clips, captionData, updateCaptionWords]);

  // Feature 8: Generate Thumbnail
  const handleGenerateThumbnail = useCallback(async (timestamp?: number): Promise<{ assetId: string }> => {
    if (!session) throw new Error('No session available');
    const videoAsset = assets.find(a => a.type === 'video' && !a.aiGenerated);
    if (!videoAsset) throw new Error('No video asset found');
    const resp = await fetch(`http://localhost:3333/session/${session.sessionId}/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'generate-thumbnail', assetId: videoAsset.id, timestamp }),
    });
    if (!resp.ok) { const e = await resp.json(); throw new Error(e.error || 'Thumbnail generation failed'); }
    const data = await resp.json();
    await refreshAssets();
    return data;
  }, [session, assets, refreshAssets]);

  // Feature 9: Waveform Data
  const handleWaveformData = useCallback(async (assetId: string): Promise<{ samples: number[]; sampleRate: number }> => {
    if (!session) throw new Error('No session available');
    const resp = await fetch(`http://localhost:3333/session/${session.sessionId}/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'waveform-data', assetId }),
    });
    if (!resp.ok) { const e = await resp.json(); throw new Error(e.error || 'Waveform data failed'); }
    return resp.json();
  }, [session]);

  // Handle auto-extract keywords and add GIFs
  const handleExtractKeywordsAndAddGifs = useCallback(async () => {
    if (!session) {
      throw new Error('No session available');
    }

    // Check if we have a video asset
    const videoAsset = assets.find(a => a.type === 'video');
    if (!videoAsset) {
      throw new Error('Please upload a video first');
    }

    // Call the transcribe-and-extract endpoint
    const response = await fetch(`http://localhost:3333/session/${session.sessionId}/transcribe-and-extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to extract keywords');
    }

    const data = await response.json();
    console.log('Transcription result:', data);

    // Refresh assets first so the new GIF assets appear in the library and preview
    await refreshAssets();

    // Add each GIF to the timeline at its timestamp on the V2 (overlay) track
    const addedClipIds: string[] = [];
    for (const gifInfo of data.gifAssets) {
      const clip = addClip(gifInfo.assetId, 'V2', gifInfo.timestamp, 3); // 3 second duration for GIFs
      if (clip) addedClipIds.push(clip.id);
    }

    // Save the project with the new clips
    await saveProject();

    return { ...data, addedClipIds };
  }, [session, assets, addClip, saveProject, refreshAssets]);

  // Handle generating B-roll images and adding to timeline
  const handleGenerateBroll = useCallback(async () => {
    if (!session) {
      throw new Error('No session available');
    }

    // Check if we have a video asset
    const videoAsset = assets.find(a => a.type === 'video');
    if (!videoAsset) {
      throw new Error('Please upload a video first');
    }

    // Build pre-built words+transcript from captionData if available (skips Whisper on server)
    let brollBody: { text?: string; words?: Array<{ text: string; start: number; end: number }> } = {};
    const t1BrollClips = clips.filter(c => c.trackId === 'T1').sort((a, b) => a.start - b.start);
    if (t1BrollClips.length > 0 && Object.keys(captionData).length > 0) {
      const words: Array<{ text: string; start: number; end: number }> = [];
      for (const clip of t1BrollClips) {
        const cd = captionData[clip.id];
        if (!cd?.words?.length) continue;
        for (const w of cd.words) {
          words.push({ text: w.text, start: clip.start + w.start, end: clip.start + w.end });
        }
      }
      if (words.length > 10) {
        brollBody = { text: words.map(w => w.text).join(' '), words };
        console.log(`Smart B-roll: using ${words.length} caption words for keyword extraction`);
      }
    }

    // Call the generate-broll endpoint
    const response = await fetch(`http://localhost:3333/session/${session.sessionId}/generate-broll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(brollBody),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to generate B-roll');
    }

    const data = await response.json();
    console.log('B-roll generation result:', data);
    console.log('B-roll assets to add:', data.brollAssets);

    if (!data.brollAssets || data.brollAssets.length === 0) {
      console.warn('No B-roll assets returned from server');
      throw new Error('No B-roll images were generated. The AI image generation may have failed - check the server logs for details.');
    }

    // Refresh assets from server to get the newly generated B-roll images
    console.log('Refreshing assets from server...');
    await refreshAssets();

    // Default B-roll transform: 1/5 screen width, lower-middle position
    // With new rendering: scale = width percentage, x = horizontal offset, y = vertical offset (positive = up)
    const DEFAULT_BROLL_TRANSFORM = {
      scale: 0.2,   // 1/5th of screen width (20%)
      x: 0,         // Centered horizontally
      y: 0,         // No vertical offset (stays at bottom 10% default position)
    };

    // Create clips directly (bypassing addClip to avoid stale closure issue)
    const newClips: TimelineClip[] = data.brollAssets.map((brollInfo: { assetId: string; keyword: string; timestamp: number }) => ({
      id: crypto.randomUUID(),
      assetId: brollInfo.assetId,
      trackId: 'V3',
      start: brollInfo.timestamp,
      duration: 3,
      inPoint: 0,
      outPoint: 3,
      transform: DEFAULT_BROLL_TRANSFORM,
    }));

    console.log(`Created ${newClips.length} B-roll clips:`, newClips);

    // Add clips to state using the setter directly via a custom approach
    // We need to update clips state - let's use updateClip for each after adding via addClip workaround
    // Actually, let's just save directly to server and reload

    // Save clips directly to server
    const projectResponse = await fetch(`http://localhost:3333/session/${session.sessionId}/project`);
    const projectData = await projectResponse.json();

    const updatedClips = [...(projectData.clips || []), ...newClips];

    await fetch(`http://localhost:3333/session/${session.sessionId}/project`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...projectData,
        clips: updatedClips,
      }),
    });

    // Reload project to sync frontend state
    await loadProject();

    console.log('B-roll clips added successfully!');

    return data;
  }, [session, assets, clips, captionData, refreshAssets, loadProject]);

  // Handle removing dead air / silence from the video
  const handleRemoveDeadAir = useCallback(async (): Promise<{ duration: number; removedDuration: number }> => {
    if (!session) {
      throw new Error('No session available');
    }

    // Check if we have a video asset (prefer original, non-AI-generated)
    const videoAsset = assets.find(a => a.type === 'video' && !a.aiGenerated) || assets.find(a => a.type === 'video');
    if (!videoAsset) {
      throw new Error('Please upload a video first');
    }

    console.log('Removing dead air from video...');

    // Call the remove-dead-air endpoint
    // -26dB catches real pauses, 0.4s avoids cutting natural speech rhythm
    const response = await fetch(`http://localhost:3333/session/${session.sessionId}/remove-dead-air`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        silenceThreshold: -26, // dB threshold
        minSilenceDuration: 0.4, // minimum silence duration in seconds
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to remove dead air');
    }

    const result = await response.json();
    console.log('Dead air removal result:', result);

    // Refresh assets to get the updated video with new cache-busting URL
    const refreshedAssets = await refreshAssets();

    // Find the current original video asset from refreshed data
    const assetPool = refreshedAssets.length > 0 ? refreshedAssets : assets;
    const currentVideoAsset = assetPool.find(a => a.type === 'video' && !a.aiGenerated) || assetPool.find(a => a.type === 'video');

    // Update V1 clip: fix asset reference + update duration
    if (result.duration) {
      const v1Clip = clips.find(c => c.trackId === 'V1');
      if (v1Clip) {
        const updates: Partial<typeof v1Clip> = {
          duration: result.duration,
          outPoint: result.duration,
        };
        // Also fix asset ID if it's stale (e.g., after server restart)
        if (currentVideoAsset && v1Clip.assetId !== currentVideoAsset.id) {
          console.log(`[DeadAir] Fixing stale asset ref: ${v1Clip.assetId} -> ${currentVideoAsset.id}`);
          updates.assetId = currentVideoAsset.id;
        }
        console.log(`[DeadAir] Updating clip ${v1Clip.id}: duration ${v1Clip.duration} -> ${result.duration}`);
        updateClip(v1Clip.id, updates);

        // Immediately save with the corrected clips — don't rely on debounced saveProject
        // (React state update from updateClip may not have propagated to clipsRef yet)
        const updatedClips = clips.map(c => c.id === v1Clip.id ? { ...c, ...updates } : c);
        await saveProjectNow(updatedClips);
      } else {
        await saveProject();
      }
    }

    return {
      duration: result.duration,
      removedDuration: result.removedDuration,
    };
  }, [session, assets, clips, refreshAssets, updateClip, saveProject, saveProjectNow]);

  // Handle transcribing video and adding captions
  const handleTranscribeAndAddCaptions = useCallback(async (options?: { highlightColor?: string; fontFamily?: string }) => {
    if (!session) {
      throw new Error('No session available');
    }

    // Use the V1 clip's asset and in/out points so we only transcribe what's actually on the timeline
    const v1Clip = clips.find(c => c.trackId === 'V1');
    let videoAsset = v1Clip ? assets.find(a => a.id === v1Clip.assetId) : undefined;
    // Fallback to any non-AI video if V1 clip not found or asset missing
    if (!videoAsset) {
      videoAsset = assets.find(a => a.type === 'video' && !a.aiGenerated) || assets.find(a => a.type === 'video');
    }
    const inPoint = v1Clip?.inPoint ?? 0;
    // Compute outPoint from inPoint + duration — more reliable than reading outPoint directly,
    // which can be missing or stale in old saved clips. duration is always correct (it drives the timeline).
    const outPoint = inPoint + (v1Clip?.duration ?? videoAsset?.duration ?? 0);
    const clipStart = v1Clip?.start ?? 0;

    if (!videoAsset || videoAsset.type !== 'video') {
      throw new Error('Please upload a video first');
    }

    // Clear any existing captions on T1 before adding new ones — prevents stale captions accumulating
    clearCaptionClips();

    // Call the transcribe endpoint — pass inPoint/outPoint so server only extracts the visible portion
    const response = await fetch(`http://localhost:3333/session/${session.sessionId}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId: videoAsset.id, inPoint, outPoint }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to transcribe video');
    }

    const data = await response.json();
    console.log('Transcription result:', data);

    if (data.words && data.words.length > 0) {
      // Split words into chunks based on natural speech pauses
      // A pause of 0.7+ seconds indicates a new caption segment
      const PAUSE_THRESHOLD = 0.7; // seconds
      const MAX_WORDS_PER_CHUNK = 5; // Cap at 5 words max
      const chunks: Array<{ words: typeof data.words; start: number; end: number }> = [];

      let currentChunk: typeof data.words = [];

      for (let i = 0; i < data.words.length; i++) {
        const word = data.words[i];
        const prevWord = data.words[i - 1];

        // Start a new chunk if:
        // 1. There's a significant pause between words
        // 2. Current chunk has reached max words
        const hasSignificantPause = prevWord && (word.start - prevWord.end) >= PAUSE_THRESHOLD;
        const chunkIsFull = currentChunk.length >= MAX_WORDS_PER_CHUNK;

        if (currentChunk.length > 0 && (hasSignificantPause || chunkIsFull)) {
          // Save current chunk
          chunks.push({
            words: currentChunk,
            start: currentChunk[0].start,
            end: currentChunk[currentChunk.length - 1].end,
          });
          currentChunk = [];
        }

        currentChunk.push(word);
      }

      // Don't forget the last chunk
      if (currentChunk.length > 0) {
        chunks.push({
          words: currentChunk,
          start: currentChunk[0].start,
          end: currentChunk[currentChunk.length - 1].end,
        });
      }

      // Create all caption clips at once (batched for performance)
      const captionsToAdd = chunks.map(chunk => {
        const duration = chunk.end - chunk.start;
        // Adjust word timestamps to be relative to chunk start
        const relativeWords = chunk.words.map((w: { text: string; start: number; end: number }) => ({
          ...w,
          start: w.start - chunk.start,
          end: w.end - chunk.start,
        }));
        return {
          words: relativeWords,
          // Word timestamps are relative to inPoint (start of extracted audio).
          // Add clipStart so captions align with where the clip sits on the timeline.
          start: chunk.start + clipStart,
          duration,
          style: {
            ...(options?.highlightColor && { highlightColor: options.highlightColor }),
            ...(options?.fontFamily && { fontFamily: options.fontFamily }),
          },
        };
      });

      const { clips: newCaptionClips, captionData: newCaptionData } = addCaptionClipsBatch(captionsToAdd);

      // Save immediately with explicit data — setClips/setCaptionData haven't propagated
      // to clipsRef/captionDataRef yet, so saveProject() would read stale refs.
      const savedClips = [...clips.filter(c => c.trackId !== 'T1'), ...newCaptionClips];
      const savedCaptionData = { ...newCaptionData }; // only new entries; orphaned old entries are harmless
      await saveProjectNow(savedClips, savedCaptionData);
      console.log(`Created ${chunks.length} caption clips`);
      return { captionClipIds: newCaptionClips.map(c => c.id), ...data };
    } else {
      throw new Error('No speech detected in video. Make sure your video has audible speech.');
    }
  }, [session, assets, clips, clearCaptionClips, addCaptionClipsBatch, saveProjectNow]);

  // Handle updating caption style
  const handleUpdateCaptionStyle = useCallback((clipId: string, styleUpdates: Partial<CaptionStyle>) => {
    updateCaptionStyle(clipId, styleUpdates);
    saveProject();
  }, [updateCaptionStyle, saveProject]);

  // Wrapper for AI prompt panel motion graphics (takes config object)
  const handleAddMotionGraphicFromPrompt = useCallback(async (config: {
    templateId: TemplateId;
    props: Record<string, unknown>;
    duration: number;
    startTime?: number;
  }) => {
    // Use startTime from config, or fall back to currentTime
    const startAt = config.startTime ?? currentTime;

    if (!session) {
      alert('Please upload a video first to start a session');
      return;
    }

    try {
      // Call the server to render the motion graphic
      const response = await fetch(`http://localhost:3333/session/${session.sessionId}/render-motion-graphic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId: config.templateId,
          props: config.props,
          duration: config.duration,
          fps: 30,
          width: 1920,
          height: 1080,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to render motion graphic');
      }

      const data = await response.json();

      // Refresh assets to sync with server (motion graphic was just created)
      await refreshAssets();

      // Add the rendered motion graphic to the timeline at specified position
      addClip(data.assetId, 'V2', startAt, config.duration);

      // Switch to Main tab so user can see the added animation
      switchTimelineTab('main');

      await saveProject();

      console.log('Motion graphic added from prompt:', data);
    } catch (error) {
      console.error('Failed to add motion graphic:', error);
      throw error; // Re-throw so AIPromptPanel can show error
    }
  }, [session, currentTime, addClip, saveProject, refreshAssets, switchTimelineTab]);

  // Handle custom AI-generated animation creation
  const handleCreateCustomAnimation = useCallback(async (description: string, startTime?: number, endTime?: number, attachedAssetIds?: string[], durationSeconds?: number) => {
    if (!session?.sessionId) {
      throw new Error('Please upload a video first to start a session');
    }

    try {
      // Find the primary video asset to use as context for the animation
      // First check V1 clips, then fall back to first video asset
      const v1Clips = clips.filter(c => c.trackId === 'V1');
      let videoAssetId: string | undefined;

      if (v1Clips.length > 0) {
        const v1Asset = assets.find(a => a.id === v1Clips[0].assetId && a.type === 'video');
        if (v1Asset) {
          videoAssetId = v1Asset.id;
        }
      }

      if (!videoAssetId) {
        const firstVideo = assets.find(a => a.type === 'video' && !a.aiGenerated);
        if (firstVideo) {
          videoAssetId = firstVideo.id;
        }
      }

      console.log(`[Animation] Creating with video context: ${videoAssetId || 'none'}, time range: ${startTime !== undefined ? `${startTime}s` : 'auto'}${endTime !== undefined ? ` - ${endTime}s` : ''}${attachedAssetIds?.length ? `, attached assets: ${attachedAssetIds.length}` : ''}${durationSeconds ? `, duration: ${durationSeconds}s` : ''}`);

      // Call the server to generate AI animation with video context
      const response = await fetch(`http://localhost:3333/session/${session.sessionId}/generate-animation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description,
          videoAssetId, // Pass video for transcript context
          startTime,    // Optional: specific time range
          endTime,      // Optional: specific time range
          attachedAssetIds, // Optional: images/videos to include in animation
          durationSeconds, // Optional: user-specified duration
          fps: 30,
          width: 1920,
          height: 1080,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to generate animation');
      }

      const data = await response.json();

      // Refresh assets to sync with server (animation was just created)
      await refreshAssets();

      const animationDuration = data.duration;

      // If startTime is provided (from time selection tool), use that
      // Otherwise, detect animation type from description for placement
      let insertTime: number;
      if (startTime !== undefined) {
        insertTime = startTime;
        console.log(`Animation added at specified time: ${startTime}s`);
      } else {
        // Detect animation type from description for auto-placement
        const lower = description.toLowerCase();
        const isIntro = lower.includes('intro') || lower.includes('opening') || lower.includes('start');
        const isOutro = lower.includes('outro') || lower.includes('ending') || lower.includes('conclusion') || lower.includes('close');
        const videoDuration = getDuration();

        if (isIntro) {
          insertTime = 0;
          console.log('Intro animation added as overlay at beginning');
        } else if (isOutro) {
          insertTime = videoDuration;
          console.log('Outro animation added as overlay at end');
        } else {
          insertTime = currentTime;
          console.log('Animation added as overlay at playhead position');
        }
      }

      // Always add animations as overlays on V2
      addClip(data.assetId, 'V2', insertTime, animationDuration);

      // Switch to Main tab so user can see the added animation
      switchTimelineTab('main');

      await saveProject();

      console.log('Custom animation generated:', data, { insertTime });

      return {
        assetId: data.assetId,
        duration: data.duration,
      };
    } catch (error) {
      console.error('Failed to create custom animation:', error);
      throw error;
    }
  }, [session, currentTime, addClip, saveProject, refreshAssets, getDuration, switchTimelineTab, clips, assets]);

  // Handle analyzing video for animation (returns concept for approval)
  const handleAnalyzeForAnimation = useCallback(async (request: {
    type: 'intro' | 'outro' | 'transition' | 'highlight';
    description?: string;
    timeRange?: { start: number; end: number };
  }) => {
    if (!session?.sessionId) {
      throw new Error('Please upload a video first to start a session');
    }

    const videoAsset = assets.find(a => a.type === 'video');
    if (!videoAsset) {
      throw new Error('Please upload a video first');
    }

    // Debug: log the time range being sent to server
    console.log('[DEBUG] Sending analyze-for-animation with timeRange:', JSON.stringify(request.timeRange));

    const response = await fetch(`http://localhost:3333/session/${session.sessionId}/analyze-for-animation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assetId: videoAsset.id,
        type: request.type,
        description: request.description,
        // Pass time range so server only analyzes that segment
        startTime: request.timeRange?.start,
        endTime: request.timeRange?.end,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to analyze video');
    }

    return await response.json();
  }, [session, assets]);

  // Handle rendering from pre-approved concept (skips analysis, uses provided scenes)
  const handleRenderFromConcept = useCallback(async (concept: {
    type: 'intro' | 'outro' | 'transition' | 'highlight';
    scenes: Array<{
      id: string;
      type: string;
      duration: number;
      content: Record<string, unknown>;
    }>;
    totalDuration: number;
    durationInSeconds: number;
    backgroundColor: string;
    contentSummary: string;
    startTime?: number; // Optional: explicit placement time
  }) => {
    if (!session?.sessionId) {
      throw new Error('Please upload a video first to start a session');
    }

    const response = await fetch(`http://localhost:3333/session/${session.sessionId}/render-from-concept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        concept,
        fps: 30,
        width: 1920,
        height: 1080,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to render animation');
    }

    const data = await response.json();

    // Refresh assets to get the newly rendered animation
    await refreshAssets();

    const animationDuration = data.duration;
    const videoDuration = getDuration();

    // Determine placement: use explicit startTime if provided, otherwise use type-based logic
    let insertTime: number;
    if (concept.startTime !== undefined) {
      // Explicit time provided (from time selection tool)
      insertTime = concept.startTime;
      console.log(`Animation placed at specified time: ${insertTime}s`);
    } else if (concept.type === 'intro') {
      insertTime = 0;
      console.log('Intro animation added at beginning');
    } else if (concept.type === 'outro') {
      insertTime = videoDuration;
      console.log('Outro animation added at end');
    } else {
      insertTime = currentTime;
      console.log('Animation added at current playhead');
    }

    // Always add as overlay on V2 - never shift the original video
    addClip(data.assetId, 'V2', insertTime, animationDuration);

    // Switch to Main tab so user can see the animation
    switchTimelineTab('main');

    await saveProject();

    console.log('Animation rendered from concept:', data, { type: concept.type, insertTime });

    return {
      assetId: data.assetId,
      duration: data.duration,
    };
  }, [session, currentTime, refreshAssets, addClip, saveProject, getDuration, switchTimelineTab]);

  // Handle generating transcript animation (kinetic typography from speech)
  const handleGenerateTranscriptAnimation = useCallback(async () => {
    if (!session?.sessionId) {
      throw new Error('Please upload a video first to start a session');
    }

    const response = await fetch(`http://localhost:3333/session/${session.sessionId}/generate-transcript-animation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fps: 30,
        width: 1920,
        height: 1080,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to generate transcript animation');
    }

    const data = await response.json();

    // Refresh assets to get the newly generated animation
    await refreshAssets();

    // Add the animation as an overlay on V2 at the current playhead
    addClip(data.assetId, 'V2', currentTime, data.duration);

    await saveProject();

    console.log('Transcript animation generated:', data);

    return {
      assetId: data.assetId,
      duration: data.duration,
    };
  }, [session, currentTime, refreshAssets, addClip, saveProject]);

  // Handle batch animation generation (multiple animations across the video)
  const handleGenerateBatchAnimations = useCallback(async (count: number) => {
    if (!session?.sessionId) {
      throw new Error('Please upload a video first to start a session');
    }

    const response = await fetch(`http://localhost:3333/session/${session.sessionId}/generate-batch-animations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        count,
        fps: 30,
        width: 1920,
        height: 1080,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to generate batch animations');
    }

    const data = await response.json();

    // Refresh assets to get the newly generated animations
    await refreshAssets();

    // Add each animation to the timeline at its planned position
    const addedClipIds: string[] = [];
    for (const animation of data.animations) {
      const clip = addClip(animation.assetId, 'V2', animation.startTime, animation.duration);
      if (clip) addedClipIds.push(clip.id);
    }

    await saveProject();

    console.log('Batch animations generated:', data);

    return {
      animations: data.animations,
      videoDuration: data.videoDuration,
      addedClipIds,
    };
  }, [session, refreshAssets, addClip, saveProject]);

  // Handle extract audio (separates audio to A1 track, replaces video with muted version)
  const handleExtractAudio = useCallback(async () => {
    if (!session?.sessionId) {
      throw new Error('Please upload a video first to start a session');
    }

    // Find the main video asset (non-AI generated, on V1)
    const v1Clip = clips.find(c => c.trackId === 'V1');
    if (!v1Clip) {
      throw new Error('No video clip found on V1 track');
    }

    const videoAsset = assets.find(a => a.id === v1Clip.assetId && a.type === 'video');
    if (!videoAsset) {
      throw new Error('No video asset found');
    }

    const response = await fetch(`http://localhost:3333/session/${session.sessionId}/extract-audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assetId: videoAsset.id,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to extract audio');
    }

    const data = await response.json();

    // Capture original V1 asset ID for undo
    const originalV1AssetId = v1Clip.assetId;

    // Refresh assets to get the new audio and muted video assets
    await refreshAssets();

    // Update V1 clip to use the muted video
    updateClip(v1Clip.id, { assetId: data.mutedVideoAsset.id });

    // Add the audio to A1 track at the same position as the video
    const a1Clip = addClip(data.audioAsset.id, 'A1', v1Clip.start, data.audioAsset.duration);

    await saveProject();

    console.log('Audio extracted:', data);

    return {
      audioAsset: data.audioAsset,
      mutedVideoAsset: data.mutedVideoAsset,
      originalAssetId: data.originalAssetId,
      addedA1ClipId: a1Clip?.id,
      modifiedV1ClipId: v1Clip.id,
      originalV1AssetId,
    };
  }, [session, clips, assets, refreshAssets, updateClip, addClip, saveProject]);

  // Undo an additive AI workflow by removing the clips it added
  const handleUndoWorkflow = useCallback(async (undoData: {
    workflowType: 'captions' | 'batch-animations' | 'auto-gif' | 'extract-audio';
    addedClipIds: string[];
    originalV1AssetId?: string;
    modifiedV1ClipId?: string;
  }) => {
    if (undoData.workflowType === 'extract-audio' && undoData.modifiedV1ClipId && undoData.originalV1AssetId) {
      // Restore the original video asset on V1 before removing the A1 clip
      updateClip(undoData.modifiedV1ClipId, { assetId: undoData.originalV1AssetId });
    }
    const newClips = clips.filter(c => !undoData.addedClipIds.includes(c.id));
    undoWorkflowClips(undoData.addedClipIds);
    await saveProjectNow(newClips);
  }, [clips, updateClip, undoWorkflowClips, saveProjectNow]);

  // Preview batch animations (renders but does NOT add to timeline) — for storyboard UI
  const handlePreviewBatchAnimations = useCallback(async (count: number) => {
    if (!session?.sessionId) {
      throw new Error('Please upload a video first to start a session');
    }

    const response = await fetch(`http://localhost:3333/session/${session.sessionId}/generate-batch-animations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count, fps: 30, width: 1920, height: 1080 }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to generate animations');
    }

    const data = await response.json();

    // Refresh assets so thumbnails are available
    const refreshed = await refreshAssets();

    // Attach thumbnailUrl from the refreshed asset list
    const withThumbs = data.animations.map((anim: { assetId: string; filename: string; duration: number; startTime: number; type: string; title: string }) => {
      const asset = refreshed?.find((a: { id: string; thumbnailUrl?: string | null }) => a.id === anim.assetId);
      return { ...anim, thumbnailUrl: asset?.thumbnailUrl ?? undefined };
    });

    return { animations: withThumbs, videoDuration: data.videoDuration };
  }, [session, refreshAssets]);

  // Apply previewed batch animations to the timeline
  const handleApplyBatchAnimations = useCallback(async (animations: Array<{ assetId: string; startTime: number; duration: number }>) => {
    const addedClipIds: string[] = [];
    for (const anim of animations) {
      const clip = addClip(anim.assetId, 'V2', anim.startTime, anim.duration);
      if (clip) addedClipIds.push(clip.id);
    }
    await saveProject();
    return { addedClipIds };
  }, [addClip, saveProject]);

  // Handle contextual animation creation (uses video content to inform the animation)
  const handleCreateContextualAnimation = useCallback(async (request: {
    type: 'intro' | 'outro' | 'transition' | 'highlight';
    description?: string;
  }) => {
    if (!session?.sessionId) {
      throw new Error('Please upload a video first to start a session');
    }

    // Find the main video asset to analyze
    const videoAsset = assets.find(a => a.type === 'video');
    if (!videoAsset) {
      throw new Error('Please upload a video first');
    }

    try {
      // Call the server to generate contextual animation
      // This endpoint will:
      // 1. Transcribe the video (if not already done)
      // 2. Analyze the content with AI
      // 3. Generate Remotion code based on the content
      // 4. Render the animation
      const response = await fetch(`http://localhost:3333/session/${session.sessionId}/generate-contextual-animation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetId: videoAsset.id,
          type: request.type,
          description: request.description,
          fps: 30,
          width: 1920,
          height: 1080,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to generate animation');
      }

      const data = await response.json();

      // Refresh assets to get the newly generated animation
      await refreshAssets();

      // Add the generated animation to the timeline
      // Intro goes at the beginning, outro at the end
      const insertTime = request.type === 'outro' ? getDuration() : 0;
      addClip(data.assetId, 'V2', insertTime, data.duration);
      await saveProject();

      console.log('Contextual animation generated:', data);

      return {
        assetId: data.assetId,
        duration: data.duration,
        contentSummary: data.contentSummary,
        sceneCount: data.sceneCount,
      };
    } catch (error) {
      console.error('Failed to create contextual animation:', error);
      throw error;
    }
  }, [session, assets, addClip, saveProject, getDuration, refreshAssets]);

  // Handle render/export with optional preset
  const handleExport = useCallback(async (preset?: ExportPreset) => {
    if (clips.length === 0) {
      alert('Add some clips to the timeline first');
      return;
    }

    try {
      // Use preset settings if provided, otherwise determine from aspect ratio
      let exportSettings;
      let filename = 'export.mp4';

      if (preset) {
        exportSettings = { ...settings, width: preset.width, height: preset.height };
        filename = `export-${preset.id}.mp4`;
        console.log(`Exporting for ${preset.label}:`, preset.width, 'x', preset.height);
      } else {
        exportSettings = aspectRatio === '9:16'
          ? { ...settings, width: 1080, height: 1920 }
          : { ...settings, width: 1920, height: 1080 };
        filename = aspectRatio === '9:16' ? 'export-vertical.mp4' : 'export.mp4';
        console.log('Exporting with settings:', exportSettings.width, 'x', exportSettings.height);
      }

      // For 9:16 aspect ratio or vertical presets, include frame template and overlay assets
      const isVertical = (preset && preset.aspectRatio === '9:16') || (!preset && aspectRatio === '9:16');
      const frameTemplateForRender = isVertical ? currentFrameTemplate : null;
      const overlayAssetsForRender = isVertical
        ? overlayAssets.map(a => ({ id: a.id, type: a.type, url: a.url }))
        : undefined;

      // Pass exportSettings explicitly to renderProject to ensure correct dimensions
      const downloadUrl = await renderProject(false, frameTemplateForRender, overlayAssetsForRender, exportSettings);

      // Trigger download
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error('Export failed:', error);
      alert(`Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }, [clips.length, renderProject, aspectRatio, currentFrameTemplate, overlayAssets, settings]);

  // Handle Command Bar commands
  const handleCommandBarCommand = useCallback((commandId: string) => {
    // Panel commands
    if (commandId === 'panel:scene') { setShowScenePanel(true); return; }
    if (commandId === 'panel:broll') { setShowBrollPanel(true); return; }
    if (commandId === 'panel:thumbnail') { setShowThumbnailPanel(true); return; }
    if (commandId === 'panel:viral') { setShowViralPanel(true); return; }
    if (commandId === 'panel:repurpose') { setShowRepurposePanel(true); return; }
    if (commandId === 'panel:remotion') { setShowRemotionPanel(true); return; }

    // Export commands - trigger export with preset settings
    if (commandId.startsWith('export:')) {
      // For now, just trigger the default export
      // TODO: Implement preset-specific export
      handleExport();
      return;
    }

    // AI commands - route to Director panel and trigger action
    // For now, just log - these will be integrated with Director
    console.log('Command:', commandId);
  }, [handleExport]);

  // Edit an existing animation with a new prompt
  const handleEditAnimation = useCallback(async (
    assetId: string,
    editPrompt: string,
    v1Context?: { assetId: string; filename: string; type: string; duration?: number },
    tabIdToUpdate?: string
  ) => {
    if (!session?.sessionId) {
      throw new Error('No active session');
    }

    // Get available assets to pass to the AI
    const availableAssets = assets
      .filter(a => a.type === 'image' || a.type === 'video')
      .map(a => ({
        id: a.id,
        type: a.type,
        filename: a.filename,
        duration: a.duration,
      }));

    const response = await fetch(`http://localhost:3333/session/${session.sessionId}/edit-animation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assetId,
        editPrompt,
        assets: availableAssets,
        v1Context, // Pass V1 clip context for hybrid approach
        fps: 30,
        width: 1920,
        height: 1080,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to edit animation');
    }

    const data = await response.json();

    console.log('[handleEditAnimation] ===== STEP 1: Server response =====');
    console.log('[handleEditAnimation] Server response:', {
      assetId: data.assetId,
      originalAssetId: assetId,
      isSameAsset: data.assetId === assetId,
      duration: data.duration,
      editCount: data.editCount,
    });

    console.log('[handleEditAnimation] ===== STEP 2: About to call refreshAssets =====');
    console.log('[handleEditAnimation] Tab to update:', tabIdToUpdate);

    // Refresh assets to sync with server (same asset ID, but updated duration/thumbnail)
    await refreshAssets();

    console.log('[handleEditAnimation] ===== STEP 3: refreshAssets complete =====');

    // Update the edit tab's clip duration if it changed (asset ID stays the same)
    if (tabIdToUpdate && tabIdToUpdate !== 'main' && data.duration) {
      console.log('[handleEditAnimation] ===== STEP 4: Updating edit tab =====');
      console.log('[handleEditAnimation] Updating edit tab clip duration:', {
        tabId: tabIdToUpdate,
        assetId: data.assetId,
        duration: data.duration,
      });
      // Update the V1 clip's duration to match the new animation duration
      updateTabAsset(tabIdToUpdate, data.assetId, data.duration);
    }

    console.log('[handleEditAnimation] ===== STEP 5: Complete =====');

    return {
      assetId: data.assetId,
      duration: data.duration,
      sceneCount: data.sceneCount,
      editCount: data.editCount,
    };
  }, [session, assets, refreshAssets, updateTabAsset]);

  // Open an animation in a new timeline tab for isolated editing
  const handleOpenAnimationInTab = useCallback((assetId: string, animationName: string) => {
    const asset = assets.find(a => a.id === assetId);
    if (!asset) return;

    // Create initial clip for the tab's timeline
    const initialClip: TimelineClip = {
      id: crypto.randomUUID(),
      assetId: assetId,
      trackId: 'V1',
      start: 0,
      duration: asset.duration || 10,
      inPoint: 0,
      outPoint: asset.duration || 10,
    };

    const tabId = createTimelineTab(animationName, assetId, [initialClip]);
    console.log('Created timeline tab for animation:', tabId, animationName);

    return tabId;
  }, [assets, createTimelineTab]);

  const isProcessing = loading || legacyProcessing;
  const currentStatus = status || legacyStatus;

  // Keyboard shortcut for "?" to show help
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        e.preventDefault();
        setShowKeyboardShortcuts(true);
      }
      if (e.key === 'Escape') {
        setShowKeyboardShortcuts(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-white overflow-hidden">
      {/* Header */}
      <header className="relative z-50 flex items-center justify-between px-6 py-3 bg-zinc-100/80 dark:bg-zinc-900/50 border-b border-zinc-200 dark:border-zinc-800/50 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gradient-to-br from-orange-500 to-amber-500 rounded-lg flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-xl font-bold bg-gradient-to-r from-orange-400 to-amber-400 bg-clip-text text-transparent">
              HyperEdit
            </h1>
          </div>
          {currentStatus && (
            <span className="text-xs text-zinc-600 dark:text-zinc-400 bg-zinc-200 dark:bg-zinc-800 px-2 py-1 rounded">
              {currentStatus}
            </span>
          )}
          <ProjectTemplates
            currentAspectRatio={aspectRatio}
            onSelectTemplate={setAspectRatio}
          />
          {aspectRatio === '9:16' && (
            <FrameTemplateSelector
              templates={frameTemplates}
              currentTemplateId={currentFrameTemplate.id}
              onSelectTemplate={handleSelectFrameTemplate}
              onDeleteTemplate={deleteFrameTemplate}
            />
          )}
        </div>
        <div className="flex items-center gap-3">
          {(session || legacySession) && (
            <>
              <button
                onClick={handleGenerateChapters}
                disabled={isProcessing || isGeneratingChapters}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${
                  isGeneratingChapters
                    ? 'bg-purple-600 text-white'
                    : legacySession || assets.some(a => a.type === 'video')
                      ? 'bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700'
                      : 'bg-zinc-300 dark:bg-zinc-800/50 text-zinc-500 cursor-help'
                } disabled:opacity-70 disabled:cursor-not-allowed`}
                title={isGeneratingChapters ? 'Generating chapters...' : legacySession || assets.some(a => a.type === 'video') ? 'Generate YouTube chapters from video' : 'Upload a video first to use this feature'}
              >
                {isGeneratingChapters ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ListOrdered className="w-4 h-4" />
                )}
                {isGeneratingChapters ? 'Generating...' : 'Chapters'}
              </button>
              {clips.length > 0 && (
                <ExportPresetsDropdown
                  onExport={handleExport}
                  disabled={isProcessing}
                />
              )}
            </>
          )}
          {/* AI Tools Dropdown - replaces 8 individual buttons */}
          <AIToolsDropdown
            onSelect={(toolId) => {
              if (toolId === 'scene') setShowScenePanel(!showScenePanel);
              else if (toolId === 'broll') setShowBrollPanel(!showBrollPanel);
              else if (toolId === 'thumbnail') setShowThumbnailPanel(true);
              else if (toolId === 'viral') setShowViralPanel(true);
              else if (toolId === 'repurpose') setShowRepurposePanel(true);
              else if (toolId === 'remotion') setShowRemotionPanel(true);
              else if (toolId === 'shortcuts') setShowKeyboardShortcuts(true);
            }}
            activePanel={
              showScenePanel ? 'scene' :
              showBrollPanel ? 'broll' :
              showThumbnailPanel ? 'thumbnail' :
              showViralPanel ? 'viral' :
              showRepurposePanel ? 'repurpose' :
              showRemotionPanel ? 'remotion' :
              null
            }
          />
        </div>
      </header>

      {/* Timeline Tabs */}
      <TimelineTabs
        tabs={timelineTabs}
        activeTabId={activeTabId}
        onSwitchTab={switchTimelineTab}
        onCloseTab={closeTimelineTab}
        onAddTab={() => {
          // Count existing "Edit Tab" tabs to generate the next number
          const editTabCount = timelineTabs.filter(t => t.name.startsWith('Edit Tab')).length;
          const tabName = editTabCount === 0 ? 'Edit Tab' : `Edit Tab ${editTabCount + 1}`;
          createTimelineTab(tabName, `edit-${Date.now()}`, []); // Empty clips array for brand new tab
        }}
        show={assets.some(a => a.type === 'video')}
      />

      {/* Chapters Modal */}
      {showChapters && chapterData && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-zinc-900 rounded-xl border border-zinc-700 max-w-lg w-full max-h-[80vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-zinc-700">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <ListOrdered className="w-5 h-5 text-orange-400" />
                YouTube Chapters
              </h2>
              <button
                onClick={() => setShowChapters(false)}
                className="p-1 hover:bg-zinc-700 rounded transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 overflow-y-auto flex-1">
              {chapterData.summary && (
                <p className="text-sm text-zinc-400 mb-4">{chapterData.summary}</p>
              )}

              <div className="bg-zinc-800 rounded-lg p-4 font-mono text-sm">
                <pre className="whitespace-pre-wrap text-zinc-200">{chapterData.youtubeFormat}</pre>
              </div>

              <div className="mt-4 space-y-2">
                {chapterData.chapters.map((ch, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      videoPreviewRef.current?.seekTo(ch.start);
                      setCurrentTime(ch.start);
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg bg-zinc-800/50 hover:bg-zinc-700/50 transition-colors flex items-center justify-between"
                  >
                    <span className="text-zinc-200">{ch.title}</span>
                    <span className="text-zinc-500 text-sm">
                      {Math.floor(ch.start / 60)}:{Math.floor(ch.start % 60).toString().padStart(2, '0')}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="p-4 border-t border-zinc-700 flex gap-2">
              <button
                onClick={handleCopyChapters}
                className="flex-1 px-4 py-2 bg-orange-600 hover:bg-orange-500 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
              >
                {copied ? (
                  <>
                    <Check className="w-4 h-4" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4" />
                    Copy for YouTube
                  </>
                )}
              </button>
              <button
                onClick={() => setShowChapters(false)}
                className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded-lg text-sm font-medium transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* Left Panel - Assets & Clip Properties */}
        <ResizablePanel
          defaultWidth={220}
          minWidth={180}
          maxWidth={400}
          side="left"
        >
          <div className="flex flex-col h-full">
            {/* Asset Library */}
            <div className={`${selectedClipId ? 'h-1/2' : 'h-full'} overflow-hidden`}>
              <AssetLibrary
                assets={assets}
                onUpload={handleAssetUpload}
                onDelete={deleteAsset}
                onDragStart={handleAssetDragStart}
                onSelect={handleAssetSelect}
                selectedAssetId={selectedAssetId}
                uploading={loading}
                onOpenGifSearch={() => {
                  if (!session?.sessionId) {
                    alert('Please upload a video first to use GIF search');
                    return;
                  }
                  setShowGifSearch(true);
                }}
              />
            </div>

            {/* Frame Template Panel (shown in 9:16 mode when no clip selected) */}
            {aspectRatio === '9:16' && !selectedClipId && (
              <div className="h-1/2 border-t border-zinc-800/50 bg-zinc-900/50 overflow-hidden">
                <FrameTemplatePanel
                  template={currentFrameTemplate}
                  savedTemplates={frameTemplates}
                  projectDuration={duration}
                  sessionId={session?.sessionId}
                  onUpdateTemplate={handleUpdateFrameTemplate}
                  onSaveTemplate={handleSaveFrameTemplate}
                  onDeleteTemplate={deleteFrameTemplate}
                  overlayAssets={overlayAssets}
                  uploading={overlayUploading}
                  onUploadAsset={uploadOverlayAsset}
                  onDeleteAsset={deleteOverlayAsset}
                />
              </div>
            )}

            {/* Clip/Caption Properties Panel (shown when clip is selected) */}
            {selectedClipId && (
              <div className="h-1/2 border-t border-zinc-800/50 bg-zinc-900/50 overflow-hidden">
                {selectedCaptionData ? (
                  <CaptionPropertiesPanel
                    captionData={selectedCaptionData}
                    onUpdateStyle={(styleUpdates) => handleUpdateCaptionStyle(selectedClipId, styleUpdates)}
                    onUpdateText={(newWords) => {
                      updateCaptionWords(selectedClipId, newWords);
                      saveProject();
                    }}
                    onClose={() => setSelectedClipId(null)}
                  />
                ) : (
                  <ClipPropertiesPanel
                    clip={selectedClip}
                    asset={selectedClipAsset}
                    onUpdateTransform={handleUpdateClipTransform}
                    onClose={() => setSelectedClipId(null)}
                  />
                )}
              </div>
            )}
          </div>
        </ResizablePanel>

        {/* Main Editor Area */}
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
          {/* Video Preview */}
          <div className="flex-1 flex items-center justify-center bg-zinc-900/30 p-4 min-h-0 overflow-hidden">
            {hasPreviewContent ? (
              <VideoPreview
                ref={videoPreviewRef}
                layers={previewLayers}
                isPlaying={isPlaying && !previewAssetId}
                aspectRatio={aspectRatio}
                currentTime={currentTime}
                projectDuration={duration}
                onLayerMove={handleLayerMove}
                onLayerSelect={handleLayerSelect}
                selectedLayerId={selectedClipId}
                frameTemplate={aspectRatio === '9:16' ? currentFrameTemplate : null}
                assets={assets}
                overlayAssets={overlayAssets}
              />
            ) : clips.length > 0 ? (
              // Assets exist but playhead is not over any clip
              <div className={`relative ${aspectRatio === '9:16' ? 'h-[65vh] w-auto aspect-[9/16]' : 'w-full max-w-4xl aspect-video'} bg-black rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/10 flex items-center justify-center`}>
                <div className="text-center text-zinc-600">
                  <div className="text-sm">No clip at playhead</div>
                  <div className="text-xs mt-1">Move playhead over a clip to preview</div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center text-zinc-500">
                <Play className="w-16 h-16 mb-4 opacity-50" />
                <p className="text-sm">Upload assets from the left panel</p>
                <p className="text-xs text-zinc-600 mt-1">Drag them to the timeline below</p>
              </div>
            )}
          </div>

          {/* Timeline - Resizable height */}
          <ResizableVerticalPanel
            defaultHeight={224}
            minHeight={150}
            maxHeight={500}
            position="bottom"
            className="bg-zinc-900/50 border-t border-zinc-800/50 overflow-hidden"
          >
            <Timeline
              tracks={tracks}
              clips={activeClips}
              assets={assets}
              selectedClipId={selectedClipId}
              currentTime={currentTime}
              duration={duration}
              isPlaying={isPlaying}
              aspectRatio={aspectRatio}
              sessionId={session?.sessionId}
              onSelectClip={handleSelectClip}
              onTimeChange={handleTimelineSeek}
              onPlayPause={handlePlayPause}
              onStop={handleStop}
              onMoveClip={handleMoveClip}
              onResizeClip={handleResizeClip}
              onDeleteClip={handleDeleteClip}
              onCutAtPlayhead={handleCutAtPlayhead}
              onAddText={handleAddText}
              onToggleAspectRatio={handleToggleAspectRatio}
              autoSnap={autoSnap}
              onToggleAutoSnap={() => setAutoSnap(prev => !prev)}
              onDropAsset={handleDropAsset}
              onSave={saveProject}
              onDeleteAllCaptionClips={handleClearAllCaptionClips}
              getCaptionData={getCaptionData}
              onUndo={handleGlobalUndo}
              frameOverlays={aspectRatio === '9:16' ? currentFrameTemplate.overlays : []}
              onUpdateOverlay={handleUpdateOverlay}
              selectedOverlayId={selectedOverlayId}
              onSelectOverlay={setSelectedOverlayId}
            />
          </ResizableVerticalPanel>
        </div>

        {/* Right Panel - AI Agents */}
        <ResizablePanel
          defaultWidth={320}
          minWidth={280}
          maxWidth={500}
          side="right"
        >
          <div className="h-full flex flex-col bg-zinc-900/80 backdrop-blur-sm">
            {/* AI Director Panel Header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/50">
              <Sparkles className="w-4 h-4 text-orange-500" />
              <span className="text-sm font-medium text-zinc-200">AI Director</span>
              <span className="text-[10px] text-zinc-500 ml-auto">Cmd+K for quick actions</span>
            </div>

            {/* AI Director Panel */}
            <div className="flex-1 overflow-hidden">
              <AIPromptPanel
                onApplyEdit={handleApplyEdit}
                onExtractKeywordsAndAddGifs={handleExtractKeywordsAndAddGifs}
                onTranscribeAndAddCaptions={handleTranscribeAndAddCaptions}
                onGenerateBroll={handleGenerateBroll}
                onRemoveDeadAir={handleRemoveDeadAir}
                onChapterCuts={handleChapterCuts}
                onAddMotionGraphic={handleAddMotionGraphicFromPrompt}
                onCreateCustomAnimation={handleCreateCustomAnimation}
                onUploadAttachment={uploadAsset}
                onAnalyzeForAnimation={handleAnalyzeForAnimation}
                onRenderFromConcept={handleRenderFromConcept}
                onGenerateTranscriptAnimation={handleGenerateTranscriptAnimation}
                onGenerateBatchAnimations={handleGenerateBatchAnimations}
                onExtractAudio={handleExtractAudio}
                onUndoWorkflow={handleUndoWorkflow}
                onPreviewBatchAnimations={handlePreviewBatchAnimations}
                onApplyBatchAnimations={handleApplyBatchAnimations}
                onCreateContextualAnimation={handleCreateContextualAnimation}
                onOpenAnimationInTab={handleOpenAnimationInTab}
                onEditAnimation={handleEditAnimation}
                isApplying={isProcessing}
                applyProgress={0}
                applyStatus={currentStatus}
                hasVideo={assets.some(a => a.type === 'video')}
                clips={clips}
                tracks={tracks}
                assets={assets}
                currentTime={currentTime}
                selectedClipId={selectedClipId}
                activeTabId={activeTabId}
                editTabAssetId={activeTabId !== 'main' ? timelineTabs.find(t => t.id === activeTabId)?.assetId : undefined}
                editTabClips={activeTabId !== 'main' ? timelineTabs.find(t => t.id === activeTabId)?.clips : undefined}
                captionData={captionData}
                onUpdateCaptionWords={updateCaptionWords}
                onSceneDetect={handleSceneDetect}
                onApplySceneCuts={handleApplySceneCuts}
                onMuteFillerWords={handleMuteFillerWords}
                onResequence={handleResequence}
                onApplyResequence={handleApplyResequence}
                onAutoReframe={handleAutoReframe}
                onAutoDuck={handleAutoDuck}
                onExportSRT={handleExportSRT}
                onSilencePreview={handleSilencePreview}
                onHighlightReel={handleHighlightReel}
                onTranslateCaptions={handleTranslateCaptions}
                onGenerateThumbnail={handleGenerateThumbnail}
                onWaveformData={handleWaveformData}
              />
            </div>
          </div>
        </ResizablePanel>
      </div>

      {/* GIF Search Modal */}
      {showGifSearch && session?.sessionId && (
        <GifSearchPanel
          sessionId={session.sessionId}
          onClose={() => setShowGifSearch(false)}
          onGifAdded={handleGifAdded}
        />
      )}

      {/* Keyboard Shortcuts Modal */}
      <KeyboardShortcuts
        isOpen={showKeyboardShortcuts}
        onClose={() => setShowKeyboardShortcuts(false)}
      />

      {/* Scene Detection Panel (floating side panel) */}
      {showScenePanel && (
        <div className="fixed right-0 top-16 bottom-0 w-80 z-40 shadow-xl">
          <SceneDetectionPanel
            scenes={scenes}
            loading={scenesLoading}
            error={scenesError}
            currentTime={currentTime}
            projectDuration={getDuration()}
            onDetectScenes={detectScenes}
            onToggleSelection={toggleSceneSelection}
            onSelectAll={selectAllScenes}
            onUpdateScene={(id, updates) => updateSceneBoundary(id, updates)}
            onMergeScenes={mergeScenes}
            onSplitScene={splitDetectedScene}
            onSplitAll={handleSplitAllScenes}
            onExportSelected={handleExportSelectedScenes}
            onSeekTo={(time) => {
              setCurrentTime(time);
              videoPreviewRef.current?.seekTo(time);
            }}
            onClearScenes={clearScenes}
            onClose={() => setShowScenePanel(false)}
          />
        </div>
      )}

      {/* B-Roll Suggestions Panel (floating side panel) */}
      {showBrollPanel && (
        <div className="fixed right-0 top-16 bottom-0 w-80 z-40 shadow-xl">
          <BrollSuggestionsPanel
            suggestions={brollSuggestions.suggestions}
            loading={brollSuggestions.loading}
            applying={brollSuggestions.applying}
            error={brollSuggestions.error}
            onFetchSuggestions={brollSuggestions.fetchSuggestions}
            onApplySuggestion={brollSuggestions.applySuggestion}
            onClear={brollSuggestions.clear}
            onClose={() => setShowBrollPanel(false)}
            onAddToTimeline={async (assetId, timestamp, duration) => {
              // Refresh assets first to get the new B-roll asset
              await refreshAssets();

              // Add B-roll clip to V2 track at the specified timestamp
              const newClip: TimelineClip = {
                id: `clip-broll-${Date.now()}`,
                assetId: assetId,
                trackId: 'V2', // Overlay track
                start: timestamp,
                duration: duration,
                inPoint: 0,
                outPoint: duration,
                transform: { scale: 0.3, x: 0, y: 0, opacity: 1 },
              };
              setClips(prev => [...prev, newClip]);
              console.log('[Home] Added B-roll clip to timeline:', newClip);
            }}
          />
        </div>
      )}

      {/* AI Thumbnail Generator Panel (modal) */}
      {showThumbnailPanel && (
        <ThumbnailGeneratorPanel
          variants={thumbnailGenerator.variants}
          loading={thumbnailGenerator.loading}
          error={thumbnailGenerator.error}
          selectedVariant={thumbnailGenerator.selectedVariant}
          recommendedIndex={thumbnailGenerator.recommendedIndex}
          explanation={thumbnailGenerator.explanation}
          prompt={thumbnailGenerator.prompt}
          onSetSelectedVariant={thumbnailGenerator.setSelectedVariant}
          onGenerate={thumbnailGenerator.generate}
          onDownload={thumbnailGenerator.downloadVariant}
          onClear={thumbnailGenerator.clearVariants}
          onClose={() => setShowThumbnailPanel(false)}
        />
      )}

      {/* Viral Edit Panel (modal) */}
      {showViralPanel && (
        <ViralEditPanel
          processing={viralEdit.processing}
          progress={viralEdit.progress}
          error={viralEdit.error}
          emphasisPoints={viralEdit.emphasisPoints}
          slowSections={viralEdit.slowSections}
          result={viralEdit.result}
          hasCaptions={clips.some(c => c.trackId === 'T1')}
          onApplyViralEdits={viralEdit.applyViralEdits}
          onClear={viralEdit.clear}
          onClose={() => setShowViralPanel(false)}
          onApplyZoomCut={(timestamp, scale) => {
            // Apply zoom cut to V1 clip at timestamp
            const clipAtTime = clips.find(c =>
              c.trackId === 'V1' &&
              c.start <= timestamp &&
              c.start + c.duration >= timestamp
            );
            if (clipAtTime) {
              setClips(prev => prev.map(c =>
                c.id === clipAtTime.id
                  ? { ...c, transform: { ...c.transform, scale: scale } }
                  : c
              ));
            }
          }}
          onUpdateCaptionStyle={(style) => {
            // Update all caption clips with karaoke animation style
            const captionClips = clips.filter(c => c.trackId === 'T1');
            captionClips.forEach(clip => {
              updateCaptionStyle(clip.id, {
                animation: style.animation as 'none' | 'pop' | 'bounce' | 'karaoke',
                highlightColor: style.highlightColor,
              });
            });
            saveProject();
          }}
        />
      )}

      {/* Content Repurposing Panel (modal) */}
      {showRepurposePanel && (
        <ContentRepurposePanel
          candidates={contentRepurpose.candidates}
          exports={contentRepurpose.exports}
          analyzing={contentRepurpose.analyzing}
          exporting={contentRepurpose.exporting}
          exportProgress={contentRepurpose.exportProgress}
          error={contentRepurpose.error}
          selectedCount={contentRepurpose.selectedCount}
          onAnalyze={contentRepurpose.analyzeForShorts}
          onToggleCandidate={contentRepurpose.toggleCandidate}
          onSelectAll={contentRepurpose.selectAll}
          onUpdateCandidate={contentRepurpose.updateCandidate}
          onExportSelected={contentRepurpose.exportSelected}
          onDownloadExport={contentRepurpose.downloadExport}
          onDownloadAll={contentRepurpose.downloadAll}
          onClear={contentRepurpose.clear}
          onClose={() => setShowRepurposePanel(false)}
        />
      )}

      {/* Remotion Generator Panel */}
      {showRemotionPanel && (
        <RemotionGeneratorPanel
          onClose={() => setShowRemotionPanel(false)}
          sessionId={session?.id}
          onAssetCreated={refreshAssets}
        />
      )}

      {/* Command Bar (Cmd+K) */}
      <CommandBar
        isOpen={showCommandBar}
        onClose={() => setShowCommandBar(false)}
        onRunCommand={handleCommandBarCommand}
      />

    </div>
  );
}
