import { useState, useRef, useEffect, useMemo } from 'react';
import { Sparkles, Send, Wand2, Clock, Terminal, CheckCircle, Loader2, VolumeX, FileVideo, Type, Image, Zap, X, Scissors, Plus, Film, Music, MapPin, Timer, ImagePlus, Move, Star, Globe } from 'lucide-react';
import type { TimelineClip, Track, Asset, CaptionData, CaptionWord } from '@/react-app/hooks/useProject';
import { MOTION_TEMPLATES, type TemplateId } from '@/remotion/templates';
import MotionGraphicsPanel from './MotionGraphicsPanel';

// Reference to a timeline element
interface TimelineReference {
  type: 'clip' | 'track' | 'timestamp';
  id?: string;
  label: string;
  details: string;
  trackId?: string;
  timestamp?: number;
}

// Attached asset for animation creation
interface AttachedAsset {
  id: string;
  filename: string;
  type: 'image' | 'video';
  thumbnailUrl?: string | null;
}

// Time range for scoped edits
interface TimeRange {
  start: number;  // seconds
  end: number;    // seconds
}

interface TranscriptKeyword {
  keyword: string;
  timestamp: number;
  confidence: number;
  gifUrl?: string;
  assetId?: string;
}

interface ChatMessage {
  type: 'user' | 'assistant';
  text: string;
  command?: string;
  explanation?: string;
  applied?: boolean;
  // For auto-GIF workflow
  extractedKeywords?: TranscriptKeyword[];
  isProcessingGifs?: boolean;
  // For caption workflow
  isCaptionWorkflow?: boolean;
  // For B-roll workflow
  isBrollWorkflow?: boolean;
  // For dead air removal workflow
  isDeadAirWorkflow?: boolean;
  // For chapter cuts workflow
  youtubeChapters?: string;
  // For animation follow-up (edit in new tab)
  animationAssetId?: string;
  animationName?: string;
  // For in-place animation edits (no "open in tab" button needed)
  isInPlaceEdit?: boolean;
  // For undo support on additive workflows
  undoData?: {
    workflowType: 'captions' | 'batch-animations' | 'auto-gif' | 'extract-audio';
    addedClipIds: string[];
    originalV1AssetId?: string;
    modifiedV1ClipId?: string;
  };
  undone?: boolean;
  // For storyboard preview (batch animations before applying to timeline)
  pendingBatchAnimations?: BatchAnimationResult[];
  batchAnimationsApplied?: boolean;
  // For audit/critic workflow
  auditResults?: AuditResult[];
  // For explain-before-execute confirm card
  confirmWorkflow?: string;
  confirmData?: { description: string; details: string[] };
  confirmed?: boolean;
  declined?: boolean;
  // For scene detect result card
  sceneDetectResult?: { scenes: Array<{ timestamp: number }>; applied?: boolean };
  // For resequence result card
  resequenceResult?: {
    swaps: Array<{ from: { startTime: number; endTime: number; label: string }; to: { startTime: number; endTime: number; label: string } }>;
    explanation: string;
    applied?: boolean;
  };
}

interface CaptionOptions {
  highlightColor: string;
  fontFamily: string;
}

interface PlatformPreset {
  id: string;
  label: string;
  emoji: string;
  width: number;
  height: number;
  aspectRatio: string;
  lufs: number;
  keywords: string[];
  command: string;
}

interface ChapterCutResult {
  chapters: Array<{ start: number; title: string }>;
  cutsApplied: number;
  youtubeFormat: string;
}

interface MotionGraphicConfig {
  templateId: TemplateId;
  props: Record<string, unknown>;
  duration: number;
  startTime?: number;
}

interface CustomAnimationResult {
  assetId: string;
  duration: number;
}

interface BatchAnimationResult {
  assetId: string;
  filename: string;
  duration: number;
  startTime: number;
  type: 'intro' | 'highlight' | 'transition' | 'callout' | 'outro';
  title: string;
  thumbnailUrl?: string;
}

interface TimelineSummary {
  videoDuration: number;
  captionCount: number;
  hasCaptions: boolean;
  animationCount: number;
  hasAnimations: boolean;
  gifCount: number;
  hasGifs: boolean;
  brollCount: number;
  hasBroll: boolean;
  hasAudioTrack: boolean;
  isEmptyTimeline: boolean;
}

interface AuditResult {
  severity: 'warning' | 'info' | 'good';
  message: string;
  fixLabel?: string;
  fixWorkflow?: 'captions' | 'batch-animations' | 'auto-gif' | 'extract-audio';
}

interface ExtractAudioResult {
  audioAsset: {
    id: string;
    filename: string;
    duration: number;
  };
  mutedVideoAsset: {
    id: string;
    filename: string;
    duration: number;
  };
  originalAssetId: string;
}

interface ContextualAnimationRequest {
  type: 'intro' | 'outro' | 'transition' | 'highlight';
  description?: string;
  timeRange?: { start: number; end: number };
}

interface RecipeStep {
  workflowType: 'dead-air' | 'captions' | 'chapter-cuts' | 'batch-animations' | 'auto-gif' | 'extract-audio';
  label: string;
  count?: number;
}

interface Recipe {
  id: string;
  label: string;
  description: string;
  steps: RecipeStep[];
}

// Animation concept returned from analysis (for approval workflow)
interface AnimationConcept {
  type: 'intro' | 'outro' | 'transition' | 'highlight';
  transcript: string;
  transcriptPreview: string;
  contentSummary: string;
  keyTopics: string[];
  scenes: Array<{
    id: string;
    type: string;
    duration: number;
    content: {
      title?: string;
      subtitle?: string;
      items?: Array<{ icon?: string; label: string; description?: string }>;
      stats?: Array<{ value: string; label: string }>;
      color?: string;
      backgroundColor?: string;
    };
  }>;
  totalDuration: number;
  durationInSeconds: number;
  backgroundColor: string;
  startTime?: number; // Optional: where to place the animation on timeline
}

// Clarifying question for tool selection
interface ClarifyingQuestion {
  id: string;
  question: string;
  options: Array<{
    label: string;
    value: string;
    description: string;
    icon?: string;
  }>;
  context: {
    originalPrompt: string;
    category: 'animation' | 'overlay' | 'edit' | 'effect';
  };
}

// Context info for V1 clip in edit tab (for hybrid asset approach)
interface EditTabV1Context {
  assetId: string;
  filename: string;
  type: 'video' | 'image' | 'audio';
  duration?: number;
  aiGenerated?: boolean; // True if this is a Remotion-generated animation
}

interface AIPromptPanelProps {
  onApplyEdit?: (command: string) => Promise<void>;
  onExtractKeywordsAndAddGifs?: () => Promise<{ addedClipIds: string[] } | void>;
  onTranscribeAndAddCaptions?: (options?: CaptionOptions) => Promise<{ captionClipIds: string[] } | void>;
  onGenerateBroll?: () => Promise<void>;
  onRemoveDeadAir?: () => Promise<{ duration: number; removedDuration: number }>;
  onChapterCuts?: () => Promise<ChapterCutResult>;
  onAddMotionGraphic?: (config: MotionGraphicConfig) => Promise<void>;
  onCreateCustomAnimation?: (description: string, startTime?: number, endTime?: number, attachedAssetIds?: string[], durationSeconds?: number) => Promise<CustomAnimationResult>;
  onUploadAttachment?: (file: File) => Promise<Asset>;
  onAnalyzeForAnimation?: (request: ContextualAnimationRequest) => Promise<{ concept: AnimationConcept }>;
  onRenderFromConcept?: (concept: AnimationConcept) => Promise<CustomAnimationResult>;
  onCreateContextualAnimation?: (request: ContextualAnimationRequest) => Promise<CustomAnimationResult>;
  onGenerateTranscriptAnimation?: () => Promise<CustomAnimationResult>;
  onGenerateBatchAnimations?: (count: number) => Promise<{ animations: BatchAnimationResult[]; videoDuration: number; addedClipIds?: string[] }>;
  onExtractAudio?: () => Promise<ExtractAudioResult & { addedA1ClipId?: string; modifiedV1ClipId?: string; originalV1AssetId?: string }>;
  onUndoWorkflow?: (undoData: NonNullable<ChatMessage['undoData']>) => Promise<void>;
  onPreviewBatchAnimations?: (count: number) => Promise<{ animations: BatchAnimationResult[]; videoDuration: number }>;
  onApplyBatchAnimations?: (animations: BatchAnimationResult[]) => Promise<{ addedClipIds: string[] }>;
  onOpenAnimationInTab?: (assetId: string, animationName: string) => string | undefined;
  onEditAnimation?: (assetId: string, editPrompt: string, v1Context?: EditTabV1Context, tabIdToUpdate?: string) => Promise<{ assetId: string; duration: number; sceneCount: number }>;
  isApplying?: boolean;
  applyProgress?: number;
  applyStatus?: string;
  hasVideo?: boolean;
  // Timeline data for reference picker
  clips?: TimelineClip[];
  tracks?: Track[];
  assets?: Asset[];
  currentTime?: number;
  selectedClipId?: string | null;
  // Edit tab context
  activeTabId?: string;
  editTabAssetId?: string;
  editTabClips?: TimelineClip[]; // Clips in the edit tab's timeline
  // Caption data for polish/filler word removal
  captionData?: Record<string, CaptionData>;
  onUpdateCaptionWords?: (clipId: string, words: CaptionWord[]) => void;
  // Scene detection
  onSceneDetect?: () => Promise<{ scenes: Array<{ timestamp: number }> }>;
  onApplySceneCuts?: (timestamps: number[]) => Promise<{ cutsApplied: number }>;
  // Filler word audio muting
  onMuteFillerWords?: (fillerWords: Set<string>) => Promise<{ mutedCount: number }>;
  // Section resequencing
  onResequence?: (instruction: string) => Promise<{
    swaps: Array<{ from: { startTime: number; endTime: number; label: string }; to: { startTime: number; endTime: number; label: string } }>;
    explanation: string;
  }>;
  onApplyResequence?: (swaps: Array<{ from: { startTime: number; endTime: number }; to: { startTime: number; endTime: number } }>) => Promise<{ applied: boolean }>;
}

export default function AIPromptPanel({
  onApplyEdit,
  onExtractKeywordsAndAddGifs,
  onTranscribeAndAddCaptions,
  onGenerateBroll,
  onRemoveDeadAir,
  onChapterCuts,
  onAddMotionGraphic,
  onCreateCustomAnimation,
  onUploadAttachment,
  onAnalyzeForAnimation,
  onRenderFromConcept,
  onCreateContextualAnimation: _onCreateContextualAnimation,
  onGenerateTranscriptAnimation,
  onGenerateBatchAnimations,
  onExtractAudio,
  onUndoWorkflow,
  onPreviewBatchAnimations,
  onApplyBatchAnimations,
  onOpenAnimationInTab,
  onEditAnimation,
  isApplying,
  applyProgress,
  applyStatus,
  hasVideo,
  clips = [],
  tracks: _tracks = [],
  assets = [],
  currentTime = 0,
  selectedClipId,
  activeTabId = 'main',
  editTabAssetId,
  editTabClips = [],
  captionData,
  onUpdateCaptionWords,
  onSceneDetect,
  onApplySceneCuts,
  onMuteFillerWords,
  onResequence,
  onApplyResequence,
}: AIPromptPanelProps) {
  const [prompt, setPrompt] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStatus, setProcessingStatus] = useState('');
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [showCaptionOptions, setShowCaptionOptions] = useState(false);
  const [showQuickActions, setShowQuickActions] = useState(false);
  const [showReferencePicker, setShowReferencePicker] = useState(false);
  const [selectedReferences, setSelectedReferences] = useState<TimelineReference[]>([]);
  const [showTimeRangePicker, setShowTimeRangePicker] = useState(false);
  const [timeRange, setTimeRange] = useState<TimeRange | null>(null);
  const [timeRangeInputs, setTimeRangeInputs] = useState({ start: '', end: '' });
  const [timeRangeError, setTimeRangeError] = useState<string | null>(null);
  const [showMotionGraphicsModal, setShowMotionGraphicsModal] = useState(false);
  const [attachedAssets, setAttachedAssets] = useState<AttachedAsset[]>([]);
  const [isUploadingAttachment, setIsUploadingAttachment] = useState(false);
  const [isDragOverChat, setIsDragOverChat] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const quickActionsRef = useRef<HTMLDivElement>(null);
  const referencePickerRef = useRef<HTMLDivElement>(null);
  const timeRangePickerRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [captionOptions, setCaptionOptions] = useState<CaptionOptions>(() => {
    try {
      const saved = localStorage.getItem('clipwise-caption-style');
      return saved ? JSON.parse(saved) : { highlightColor: '#FFD700', fontFamily: 'Inter' };
    } catch { return { highlightColor: '#FFD700', fontFamily: 'Inter' }; }
  });
  const [savedPrompts, setSavedPrompts] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('clipwise-saved-prompts');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [pendingQuestion, setPendingQuestion] = useState<ClarifyingQuestion | null>(null);
  const [pendingAnimationConcept, setPendingAnimationConcept] = useState<AnimationConcept | null>(null);
  const [applyingIndex, setApplyingIndex] = useState<number | null>(null);
  const [showRecipes, setShowRecipes] = useState(false);
  const recipesRef = useRef<HTMLDivElement>(null);
  const [showPlatforms, setShowPlatforms] = useState(false);
  const platformsRef = useRef<HTMLDivElement>(null);

  // Intentionally unused - kept for backwards compatibility
  void _onCreateContextualAnimation;

  // Compute V1 clip context from edit tab timeline (hybrid approach)
  // This auto-detects what's on V1 to give the AI context about available clips
  const editTabV1Context: EditTabV1Context | null = (() => {
    if (activeTabId === 'main' || !editTabClips || editTabClips.length === 0) {
      return null;
    }
    // Find the first clip on V1 track in the edit tab
    const v1Clip = editTabClips.find(c => c.trackId === 'V1');
    if (!v1Clip) return null;

    // Get the asset info for this clip
    const asset = assets.find(a => a.id === v1Clip.assetId);
    if (!asset) return null;

    return {
      assetId: asset.id,
      filename: asset.filename,
      type: asset.type,
      duration: asset.duration,
      aiGenerated: asset.aiGenerated,
    };
  })();

  // Close quick actions when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (quickActionsRef.current && !quickActionsRef.current.contains(event.target as Node)) {
        setShowQuickActions(false);
      }
    };

    if (showQuickActions) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showQuickActions]);

  // Close recipes when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (recipesRef.current && !recipesRef.current.contains(event.target as Node)) {
        setShowRecipes(false);
      }
    };

    if (showRecipes) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showRecipes]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (platformsRef.current && !platformsRef.current.contains(event.target as Node)) {
        setShowPlatforms(false);
      }
    };
    if (showPlatforms) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showPlatforms]);

  // Close reference picker when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (referencePickerRef.current && !referencePickerRef.current.contains(event.target as Node)) {
        setShowReferencePicker(false);
      }
    };

    if (showReferencePicker) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showReferencePicker]);

  // Close time range picker when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (timeRangePickerRef.current && !timeRangePickerRef.current.contains(event.target as Node)) {
        setShowTimeRangePicker(false);
      }
    };

    if (showTimeRangePicker) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showTimeRangePicker]);

  // Auto-scroll to bottom when chat history changes or processing state changes
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, isProcessing]);

  // Helper to format time
  const formatTimeShort = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Computed timeline summary — updated any time clips or assets change
  const timelineSummary = useMemo((): TimelineSummary => {
    const v1Clips = clips.filter(c => c.trackId === 'V1');
    const t1Clips = clips.filter(c => c.trackId === 'T1');
    const v2Clips = clips.filter(c => c.trackId === 'V2');
    const v3Clips = clips.filter(c => c.trackId === 'V3');
    const a1Clips = clips.filter(c => c.trackId === 'A1');
    const a2Clips = clips.filter(c => c.trackId === 'A2');

    const videoDuration = v1Clips.reduce((max, c) => Math.max(max, c.start + c.duration), 0);

    const animationClips = v2Clips.filter(c => assets.find(a => a.id === c.assetId)?.aiGenerated);
    const gifClips = v2Clips.filter(c => {
      const asset = assets.find(a => a.id === c.assetId);
      return asset && !asset.aiGenerated;
    });

    const captionCount = t1Clips.length;
    const animationCount = animationClips.length;
    const gifCount = gifClips.length;
    const brollCount = v3Clips.length;
    const hasAudioTrack = a1Clips.length > 0 || a2Clips.length > 0;

    return {
      videoDuration,
      captionCount,
      hasCaptions: captionCount > 0,
      animationCount,
      hasAnimations: animationCount > 0,
      gifCount,
      hasGifs: gifCount > 0,
      brollCount,
      hasBroll: brollCount > 0,
      hasAudioTrack,
      isEmptyTimeline: clips.length === 0,
    };
  }, [clips, assets]);

  // Parse time string (M:SS or MM:SS) to seconds
  const parseTimeString = (timeStr: string): number | null => {
    const trimmed = timeStr.trim();
    if (!trimmed) return null;

    // Handle M:SS or MM:SS format
    const colonMatch = trimmed.match(/^(\d{1,2}):(\d{2})$/);
    if (colonMatch) {
      const mins = parseInt(colonMatch[1], 10);
      const secs = parseInt(colonMatch[2], 10);
      if (secs < 60) {
        return mins * 60 + secs;
      }
    }

    // Handle plain seconds
    const plainSeconds = parseFloat(trimmed);
    if (!isNaN(plainSeconds) && plainSeconds >= 0) {
      return plainSeconds;
    }

    return null;
  };

  // Apply time range from inputs
  const applyTimeRange = () => {
    const start = parseTimeString(timeRangeInputs.start);
    const end = parseTimeString(timeRangeInputs.end);

    if (start === null || end === null) {
      setTimeRangeError('Use M:SS format (e.g. 0:03, 0:33) — not decimal seconds');
      return;
    }
    if (end <= start) {
      setTimeRangeError('End time must be after start time');
      return;
    }
    if (end - start < 1) {
      setTimeRangeError(`Range is only ${((end - start) * 1000).toFixed(0)}ms — did you mean M:SS? e.g. 0:03`);
      return;
    }
    setTimeRangeError(null);
    setTimeRange({ start, end });
    setShowTimeRangePicker(false);
  };

  // Clear time range
  const clearTimeRange = () => {
    setTimeRange(null);
    setTimeRangeInputs({ start: '', end: '' });
    setTimeRangeError(null);
  };

  // Add a reference (or attach asset for animation if it's an image/video)
  const addReference = (ref: TimelineReference) => {
    setShowReferencePicker(false);

    // For image/video assets, add as attachment for Remotion animations instead of reference
    if (ref.type === 'clip') {
      const asset = assets.find(a => a.id === ref.id);
      if (asset && (asset.type === 'image' || asset.type === 'video')) {
        // Don't add duplicate attachments
        if (!attachedAssets.some(a => a.id === asset.id)) {
          setAttachedAssets(prev => [...prev, {
            id: asset.id,
            filename: asset.filename,
            type: asset.type as 'image' | 'video',
            thumbnailUrl: asset.thumbnailUrl,
          }]);
        }
        return; // Don't add to selectedReferences - attachment tag is enough
      }
    }

    // For other reference types (audio, etc.), add to references
    if (selectedReferences.some(r => r.type === ref.type && r.id === ref.id && r.timestamp === ref.timestamp)) {
      return;
    }
    setSelectedReferences(prev => [...prev, ref]);
  };

  // Remove a reference (and its corresponding attachment if any)
  const removeReference = (index: number) => {
    const refToRemove = selectedReferences[index];
    setSelectedReferences(prev => prev.filter((_, i) => i !== index));

    // Also remove from attachedAssets if this was an attached asset
    if (refToRemove?.type === 'clip') {
      setAttachedAssets(prev => prev.filter(a => a.id !== refToRemove.id));
    }
  };

  // Handle file attachment for animations
  const handleFileAttachment = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !onUploadAttachment) return;

    setIsUploadingAttachment(true);
    try {
      for (const file of Array.from(files)) {
        // Only allow images and videos
        if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
          console.warn('Skipping non-image/video file:', file.name);
          continue;
        }

        const asset = await onUploadAttachment(file);
        if (asset && (asset.type === 'image' || asset.type === 'video')) {
          setAttachedAssets(prev => [...prev, {
            id: asset.id,
            filename: asset.filename,
            type: asset.type as 'image' | 'video',
            thumbnailUrl: asset.thumbnailUrl,
          }]);
        }
      }
    } catch (error) {
      console.error('Failed to upload attachment:', error);
    } finally {
      setIsUploadingAttachment(false);
      // Reset the input so the same file can be selected again
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // Remove an attached asset
  const removeAttachment = (index: number) => {
    setAttachedAssets(prev => prev.filter((_, i) => i !== index));
  };

  // Clear all attachments (called after successful animation creation)
  const clearAttachments = () => {
    setAttachedAssets([]);
  };

  // Handle drag over for asset drops from library
  const handleDragOver = (e: React.DragEvent) => {
    // Check if this is an asset drag from the library
    if (e.dataTransfer.types.includes('application/x-hyperedit-asset')) {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOverChat(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only set to false if we're leaving the container (not entering a child)
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOverChat(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOverChat(false);

    const assetData = e.dataTransfer.getData('application/x-hyperedit-asset');
    if (!assetData) return;

    try {
      const asset = JSON.parse(assetData);
      // Only accept images and GIFs (which are also type 'image')
      if (asset.type === 'image') {
        // Check if already attached
        if (attachedAssets.some(a => a.id === asset.id)) {
          console.log('Asset already attached:', asset.filename);
          return;
        }
        setAttachedAssets(prev => [...prev, {
          id: asset.id,
          filename: asset.filename,
          type: asset.type as 'image' | 'video',
          thumbnailUrl: asset.thumbnailUrl,
        }]);
        console.log('Asset attached from drag:', asset.filename);
      } else {
        console.log('Only images/GIFs can be dropped here. Got:', asset.type);
      }
    } catch (err) {
      console.error('Failed to parse dropped asset:', err);
    }
  };

  // Build reference context for the prompt
  const buildReferenceContext = (): string => {
    const parts: string[] = [];

    // Add time range context if set
    if (timeRange) {
      parts.push(`[Time Range: ${formatTimeShort(timeRange.start)} - ${formatTimeShort(timeRange.end)}]`);
    }

    // Add reference context
    selectedReferences.forEach(ref => {
      if (ref.type === 'clip') {
        parts.push(`[Clip: ${ref.label} on ${ref.trackId} at ${ref.details}]`);
      } else if (ref.type === 'track') {
        parts.push(`[Track: ${ref.label}]`);
      } else if (ref.type === 'timestamp') {
        parts.push(`[Timestamp: ${ref.details}]`);
      }
    });

    if (parts.length === 0) return '';
    return parts.join(' ') + '\n\n';
  };

  const FONT_OPTIONS = [
    'Inter', 'Roboto', 'Poppins', 'Montserrat', 'Oswald', 'Bebas Neue', 'Arial', 'Helvetica'
  ];

  const PLATFORM_PRESETS: PlatformPreset[] = [
    {
      id: 'youtube',
      label: 'YouTube',
      emoji: '▶',
      width: 1920, height: 1080, aspectRatio: '16:9', lufs: -16,
      keywords: ['youtube', 'yt'],
      command: 'ffmpeg -i input.mp4 -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2" -af "loudnorm=I=-16:TP=-1.5:LRA=11" -c:v libx264 -preset slow -crf 18 -c:a aac -b:a 192k output.mp4',
    },
    {
      id: 'tiktok',
      label: 'TikTok / Shorts',
      emoji: '♪',
      width: 1080, height: 1920, aspectRatio: '9:16', lufs: -14,
      keywords: ['tiktok', 'tik tok', 'shorts', 'vertical video'],
      command: 'ffmpeg -i input.mp4 -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" -af "loudnorm=I=-14:TP=-1.5:LRA=11" -c:v libx264 -preset slow -crf 18 -c:a aac -b:a 192k output.mp4',
    },
    {
      id: 'reels',
      label: 'Instagram Reels',
      emoji: '◎',
      width: 1080, height: 1920, aspectRatio: '9:16', lufs: -14,
      keywords: ['reels', 'instagram reels'],
      command: 'ffmpeg -i input.mp4 -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" -af "loudnorm=I=-14:TP=-1.5:LRA=11" -c:v libx264 -preset slow -crf 18 -c:a aac -b:a 192k output.mp4',
    },
    {
      id: 'instagram',
      label: 'Instagram Square',
      emoji: '□',
      width: 1080, height: 1080, aspectRatio: '1:1', lufs: -14,
      keywords: ['instagram square', 'square video'],
      command: 'ffmpeg -i input.mp4 -vf "scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2" -af "loudnorm=I=-14:TP=-1.5:LRA=11" -c:v libx264 -preset slow -crf 18 -c:a aac -b:a 192k output.mp4',
    },
    {
      id: 'twitter',
      label: 'Twitter / X',
      emoji: '✕',
      width: 1280, height: 720, aspectRatio: '16:9', lufs: -14,
      keywords: ['twitter', 'tweet'],
      command: 'ffmpeg -i input.mp4 -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2" -af "loudnorm=I=-14:TP=-1.5:LRA=11" -c:v libx264 -preset slow -crf 18 -c:a aac -b:a 192k output.mp4',
    },
  ];

  const RECIPES: Recipe[] = [
    {
      id: 'youtube-ready',
      label: 'YouTube-Ready',
      description: 'Remove silence → captions → chapters → 5 animations',
      steps: [
        { workflowType: 'dead-air',         label: 'Removing dead air...' },
        { workflowType: 'captions',         label: 'Adding captions...' },
        { workflowType: 'chapter-cuts',     label: 'Cutting at chapters...' },
        { workflowType: 'batch-animations', label: 'Adding animations...', count: 5 },
      ],
    },
    {
      id: 'podcast-polish',
      label: 'Podcast Polish',
      description: 'Remove silence → extract audio → add captions',
      steps: [
        { workflowType: 'dead-air',      label: 'Removing dead air...' },
        { workflowType: 'extract-audio', label: 'Extracting audio...' },
        { workflowType: 'captions',      label: 'Adding captions...' },
      ],
    },
    {
      id: 'social-clip',
      label: 'Social Clip',
      description: 'Remove silence → captions → 3 GIF overlays',
      steps: [
        { workflowType: 'dead-air', label: 'Removing dead air...' },
        { workflowType: 'captions', label: 'Adding captions...' },
        { workflowType: 'auto-gif', label: 'Adding GIF overlays...' },
      ],
    },
    {
      id: 'tutorial',
      label: 'Tutorial',
      description: 'Remove silence → captions → chapter each step → 4 step animations',
      steps: [
        { workflowType: 'dead-air',         label: 'Removing dead air...' },
        { workflowType: 'captions',         label: 'Adding captions...' },
        { workflowType: 'chapter-cuts',     label: 'Cutting at chapters...' },
        { workflowType: 'batch-animations', label: 'Adding step animations...', count: 4 },
      ],
    },
    {
      id: 'talking-head',
      label: 'Talking Head',
      description: 'Remove silence → captions → extract audio to A1',
      steps: [
        { workflowType: 'dead-air',      label: 'Removing dead air...' },
        { workflowType: 'captions',      label: 'Adding captions...' },
        { workflowType: 'extract-audio', label: 'Extracting audio...' },
      ],
    },
    {
      id: 'viral-short',
      label: 'Viral Short',
      description: 'Remove silence → GIF overlays → captions',
      steps: [
        { workflowType: 'dead-air', label: 'Removing dead air...' },
        { workflowType: 'auto-gif', label: 'Adding GIF overlays...' },
        { workflowType: 'captions', label: 'Adding captions...' },
      ],
    },
    {
      id: 'interview',
      label: 'Interview',
      description: 'Remove silence → captions → chapter by topic',
      steps: [
        { workflowType: 'dead-air',     label: 'Removing dead air...' },
        { workflowType: 'captions',     label: 'Adding captions...' },
        { workflowType: 'chapter-cuts', label: 'Cutting at chapters...' },
      ],
    },
    {
      id: 'product-demo',
      label: 'Product Demo',
      description: 'Captions → 5 feature animations → chapter sections',
      steps: [
        { workflowType: 'captions',         label: 'Adding captions...' },
        { workflowType: 'batch-animations', label: 'Adding feature animations...', count: 5 },
        { workflowType: 'chapter-cuts',     label: 'Cutting at chapters...' },
      ],
    },
  ];

  const suggestions = [
    { icon: Type, text: 'Add captions' },
    { icon: VolumeX, text: 'Remove dead air / silence' },
    { icon: Wand2, text: 'Remove background noise' },
    { icon: Clock, text: 'Speed up by 1.5x' },
    { icon: FileVideo, text: 'Add GIF animations' },
    { icon: Image, text: 'Add B-roll images' },
    { icon: Scissors, text: 'Cut at chapters' },
    { icon: Sparkles, text: 'Create demo animation' },
    { icon: Zap, text: 'Animate transcript' },
    { icon: Film, text: 'Add 5 animations' },
    { icon: Move, text: 'Add Ken Burns zoom effect' },
    { icon: Music, text: 'Extract audio to A1' },
  ];

  // Persist caption style to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('clipwise-caption-style', JSON.stringify(captionOptions));
  }, [captionOptions]);

  const savePrompt = (text: string) => {
    // Strip any time-range or @ref prefixes before saving
    const clean = text.replace(/^\[[\d:]+\s*-\s*[\d:]+\]\s*/, '').replace(/^(@\S+\s*)+/, '').trim();
    if (!clean) return;
    setSavedPrompts(prev => {
      if (prev.includes(clean)) return prev;
      const updated = [clean, ...prev].slice(0, 8);
      localStorage.setItem('clipwise-saved-prompts', JSON.stringify(updated));
      return updated;
    });
  };

  const removePrompt = (text: string) => {
    setSavedPrompts(prev => {
      const updated = prev.filter(p => p !== text);
      localStorage.setItem('clipwise-saved-prompts', JSON.stringify(updated));
      return updated;
    });
  };

  // Check if prompt is asking for a contextual animation (intro/outro that needs video context)
  // Note: This is still used by the contextual-animation workflow
  const isContextualAnimationPrompt = (text: string): { isMatch: boolean; type: 'intro' | 'outro' | 'transition' | 'highlight' } => {
    const lower = text.toLowerCase();

    // Intro detection
    if (
      lower.includes('intro') ||
      lower.includes('introduction') ||
      lower.includes('opening') ||
      (lower.includes('start') && (lower.includes('animation') || lower.includes('video'))) ||
      (lower.includes('beginning') && lower.includes('animation'))
    ) {
      return { isMatch: true, type: 'intro' };
    }

    // Outro detection
    if (
      lower.includes('outro') ||
      lower.includes('ending') ||
      lower.includes('conclusion') ||
      (lower.includes('end') && (lower.includes('animation') || lower.includes('video'))) ||
      lower.includes('closing')
    ) {
      return { isMatch: true, type: 'outro' };
    }

    // Transition detection
    if (
      lower.includes('transition') ||
      lower.includes('between scene') ||
      lower.includes('scene change')
    ) {
      return { isMatch: true, type: 'transition' };
    }

    // Highlight detection
    if (
      lower.includes('highlight') ||
      lower.includes('key moment') ||
      lower.includes('important part')
    ) {
      return { isMatch: true, type: 'highlight' };
    }

    return { isMatch: false, type: 'intro' };
  };

  // Parse duration from user prompt (e.g., "5 second", "10s", "15 seconds", "1 minute", "30sec")
  const parseDurationFromPrompt = (text: string): number | undefined => {
    const lower = text.toLowerCase();

    // Match patterns like "5 second", "10s", "15 seconds", "5sec", "5-second"
    const secondsMatch = lower.match(/(\d+(?:\.\d+)?)\s*[-]?\s*(?:second|sec|s\b)/);
    if (secondsMatch) {
      const seconds = parseFloat(secondsMatch[1]);
      if (seconds >= 1 && seconds <= 120) { // Reasonable bounds: 1s to 2min
        return seconds;
      }
    }

    // Match patterns like "1 minute", "2min", "1.5 minutes"
    const minutesMatch = lower.match(/(\d+(?:\.\d+)?)\s*[-]?\s*(?:minute|min|m\b)/);
    if (minutesMatch) {
      const minutes = parseFloat(minutesMatch[1]);
      const seconds = minutes * 60;
      if (seconds >= 1 && seconds <= 120) {
        return seconds;
      }
    }

    // Match "long" or "short" keywords for rough duration hints
    if (lower.includes('long animation') || lower.includes('longer')) {
      return 15; // Default "long" = 15 seconds
    }
    if (lower.includes('short animation') || lower.includes('quick') || lower.includes('brief')) {
      return 5; // Default "short" = 5 seconds
    }

    return undefined; // Let the AI decide
  };

  // Parse time range from user prompt (e.g., "0:10-0:15", "at 1:30", "from 0:00 to 0:05", "10s-20s")
  const parseTimeRangeFromPrompt = (text: string): { start: number; end: number } | undefined => {
    // Match "M:SS-M:SS" or "M:SS to M:SS" patterns (e.g., "0:10-0:15", "1:00 to 1:30")
    const rangeMatch = text.match(/(\d{1,2}):(\d{2})\s*[-–to]+\s*(\d{1,2}):(\d{2})/i);
    if (rangeMatch) {
      const startMins = parseInt(rangeMatch[1], 10);
      const startSecs = parseInt(rangeMatch[2], 10);
      const endMins = parseInt(rangeMatch[3], 10);
      const endSecs = parseInt(rangeMatch[4], 10);

      if (startSecs < 60 && endSecs < 60) {
        const start = startMins * 60 + startSecs;
        const end = endMins * 60 + endSecs;
        if (end > start) {
          return { start, end };
        }
      }
    }

    // Match "Xs-Ys" or "X seconds to Y seconds" patterns (e.g., "10s-20s", "10 seconds to 20 seconds")
    const secsRangeMatch = text.match(/(\d+)\s*(?:s|sec|seconds?)\s*[-–to]+\s*(\d+)\s*(?:s|sec|seconds?)/i);
    if (secsRangeMatch) {
      const start = parseInt(secsRangeMatch[1], 10);
      const end = parseInt(secsRangeMatch[2], 10);
      if (end > start && start >= 0 && end <= 3600) {
        return { start, end };
      }
    }

    // Match "at M:SS" or "@ M:SS" patterns for single timestamp (create 5s window around it)
    const atMatch = text.match(/(?:at|@)\s*(\d{1,2}):(\d{2})/i);
    if (atMatch) {
      const mins = parseInt(atMatch[1], 10);
      const secs = parseInt(atMatch[2], 10);
      if (secs < 60) {
        const time = mins * 60 + secs;
        return { start: Math.max(0, time - 2), end: time + 5 }; // 2s before to 5s after
      }
    }

    // Match "at Xs" or "@ Xs" patterns (e.g., "at 30s", "@ 45 seconds")
    const atSecsMatch = text.match(/(?:at|@)\s*(\d+)\s*(?:s|sec|seconds?)/i);
    if (atSecsMatch) {
      const time = parseInt(atSecsMatch[1], 10);
      if (time >= 0 && time <= 3600) {
        return { start: Math.max(0, time - 2), end: time + 5 };
      }
    }

    // Match "from M:SS" without explicit end (use 10s duration)
    const fromMatch = text.match(/from\s*(\d{1,2}):(\d{2})/i);
    if (fromMatch && !text.match(/from\s*\d{1,2}:\d{2}\s*to/i)) {
      const mins = parseInt(fromMatch[1], 10);
      const secs = parseInt(fromMatch[2], 10);
      if (secs < 60) {
        const start = mins * 60 + secs;
        return { start, end: start + 10 };
      }
    }

    return undefined;
  };

  // Handle contextual animation workflow (analyzes first, shows concept for approval)
  const handleContextualAnimationWorkflow = async (type: 'intro' | 'outro' | 'transition' | 'highlight', description?: string, timeRange?: { start: number; end: number }) => {
    if (!onAnalyzeForAnimation) return;

    setIsProcessing(true);

    const typeLabels = {
      intro: 'intro animation',
      outro: 'outro animation',
      transition: 'transition',
      highlight: 'highlight animation',
    };

    setProcessingStatus(`Analyzing video for ${typeLabels[type]}...`);

    try {
      const rangeStr = timeRange ? ` (${formatTimeShort(timeRange.start)}-${formatTimeShort(timeRange.end)})` : '';
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `🎬 Analyzing your video${rangeStr} for a contextual ${typeLabels[type]}...\n\n1. Transcribing${timeRange ? ' selected segment' : ' video'} to understand content\n2. Identifying key themes and topics\n3. Designing animation scenes\n\nPlease wait...`,
        isProcessingGifs: true,
      }]);

      // Step 1: Analyze the video and get the concept, passing time range if specified
      const { concept } = await onAnalyzeForAnimation({ type, description, timeRange });

      // Store the concept with start time for placement on approval
      const conceptWithTime = timeRange ? { ...concept, startTime: timeRange.start } : concept;
      setPendingAnimationConcept(conceptWithTime);

      // Update chat to show the concept for approval
      setChatHistory(prev => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (updated[lastIdx]?.isProcessingGifs) {
          updated[lastIdx] = {
            ...updated[lastIdx],
            text: `📋 Animation Concept Ready for Review\n\nType: ${typeLabels[type]}\nDuration: ${concept.durationInSeconds.toFixed(1)}s (${concept.totalDuration} frames)\n\nVideo Summary:\n${concept.contentSummary}\n\nKey Topics: ${concept.keyTopics.join(', ') || 'N/A'}\n\nProposed Scenes (${concept.scenes.length}):\n${concept.scenes.map((s, i) => `${i + 1}. ${s.type} (${(s.duration / 30).toFixed(1)}s): ${s.content.title || s.content.items?.map(item => item.label).join(', ') || 'Transition'}`).join('\n')}\n\n👆 Review the concept above and click Approve to render, or Edit to modify.`,
            isProcessingGifs: false,
          };
        }
        return updated;
      });

    } catch (error) {
      console.error('Contextual animation workflow error:', error);
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `❌ Failed to analyze video: ${error instanceof Error ? error.message : 'Unknown error'}\n\nMake sure you have a video uploaded and the FFmpeg server is running.`,
      }]);
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  // Handle approving the animation concept and rendering
  const handleApproveAnimation = async () => {
    if (!pendingAnimationConcept || !onRenderFromConcept) return;

    setIsProcessing(true);
    setProcessingStatus('Rendering animation...');

    const typeLabels = {
      intro: 'intro animation',
      outro: 'outro animation',
      transition: 'transition',
      highlight: 'highlight animation',
    };

    try {
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `✅ Concept approved! Rendering ${typeLabels[pendingAnimationConcept.type]}...\n\nThis may take a moment...`,
        isProcessingGifs: true,
      }]);

      // Pass the full concept with scenes to render directly
      const result = await onRenderFromConcept(pendingAnimationConcept);

      // Update the last message to show completion
      setChatHistory(prev => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (updated[lastIdx]?.isProcessingGifs) {
          updated[lastIdx] = {
            ...updated[lastIdx],
            text: `🎉 ${typeLabels[pendingAnimationConcept.type]} rendered successfully!\n\nDuration: ${result.duration}s\n\nThe animation has been added to your timeline.`,
            isProcessingGifs: false,
            applied: true,
            animationAssetId: result.assetId,
            animationName: `${typeLabels[pendingAnimationConcept.type]}`,
          };
        }
        return updated;
      });

      // Clear the pending concept
      setPendingAnimationConcept(null);

    } catch (error) {
      console.error('Animation render error:', error);
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `❌ Failed to render animation: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }]);
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  // Handle canceling/editing the animation concept
  const handleCancelAnimation = () => {
    setPendingAnimationConcept(null);
    setChatHistory(prev => [...prev, {
      type: 'assistant',
      text: `Animation concept cancelled. You can try again with a different prompt or adjust your request.`,
    }]);
  };

  // Handle when user selects a clarification option
  const handleClarificationChoice = async (questionId: string, choice: string) => {
    if (!pendingQuestion || pendingQuestion.id !== questionId) return;

    const { originalPrompt: _originalPrompt } = pendingQuestion.context;
    void _originalPrompt; // May be used for future context
    setPendingQuestion(null);

    // Add user's choice to chat
    const selectedOption = pendingQuestion.options.find(o => o.value === choice);
    setChatHistory(prev => [...prev, {
      type: 'user',
      text: `${selectedOption?.icon || ''} ${selectedOption?.label}`,
    }]);

    // Route to appropriate workflow based on choice
    switch (choice) {
      case 'custom-animation':
        // Ask for more details about the animation
        setChatHistory(prev => [...prev, {
          type: 'assistant',
          text: 'Great! Describe what you want to animate. For example:\n\n• "A 3-step demo: Sign up, Browse, Purchase"\n• "Show our 3 main features with icons"\n• "Animated stats: 10K users, 99% uptime"',
        }]);
        break;

      case 'motion-template':
        // Show available template categories
        setChatHistory(prev => [...prev, {
          type: 'assistant',
          text: 'What type of template would you like?\n\n• Lower Third - Name & title overlay\n• Counter - Animated numbers/stats\n• Progress Bar - Visual progress indicator\n• Call to Action - Subscribe/Like buttons\n• Chart - Bar, pie, or line charts\n• Logo Reveal - Animated logo intro\n\nDescribe what you need, e.g. "Add a lower third for John Smith, CEO"',
        }]);
        break;

      case 'gif-overlay':
        await handleAutoGifWorkflow();
        break;

      case 'text-animation':
        setChatHistory(prev => [...prev, {
          type: 'assistant',
          text: 'What text would you like to animate? Include the style if you have a preference:\n\n• Typewriter - Text appears letter by letter\n• Bounce - Text bounces in\n• Fade - Smooth fade in\n• Glitch - Digital glitch effect\n\nExample: "Add animated text \'Welcome!\' with bounce effect"',
        }]);
        break;

      default:
        setChatHistory(prev => [...prev, {
          type: 'assistant',
          text: 'I\'ll help you with that. Could you describe what you want in more detail?',
        }]);
    }
  };

  // ===========================================
  // DIRECTOR: Intelligent workflow routing
  // ===========================================
  // The Director analyzes the user's prompt AND context to determine
  // which workflow is most appropriate. It doesn't use priority - it
  // uses understanding of what the user wants.

  type WorkflowType =
    | 'edit-animation'      // Modify an existing Remotion animation
    | 'create-animation'    // Create a new Remotion animation
    | 'batch-animations'    // Generate multiple animations across the video
    | 'motion-graphics'     // Add template-based motion graphics
    | 'captions'            // Add captions to video
    | 'auto-gif'            // Extract keywords and add GIFs
    | 'b-roll'              // Generate AI B-roll images
    | 'dead-air'            // Remove silence from video
    | 'chapter-cuts'        // Split video into chapters
    | 'transcript-animation' // Kinetic typography from speech
    | 'contextual-animation' // Animation based on video content
    | 'extract-audio'       // Extract audio to separate track
    | 'audit'               // Audit timeline and give improvement feedback
    | 'audio-clean'        // Noise reduction + high-pass filter
    | 'audio-normalize'    // EBU R128 loudness normalization
    | 'caption-polish'     // Remove filler words from caption word list
    | 'platform-preset'    // Re-encode for YouTube / TikTok / Reels / etc.
    | 'scene-detect'       // Detect scene changes via FFmpeg
    | 'filler-cut'         // Mute filler words in audio using caption timestamps
    | 'resequence'         // Reorder sections via caption transcript + Gemini
    | 'ffmpeg-edit'         // Direct FFmpeg video manipulation
    | 'unknown';            // Need to ask for clarification

  interface DirectorContext {
    prompt: string;
    isOnEditTab: boolean;
    editTabHasAnimation: boolean;
    editTabAssetId?: string;
    hasVideo: boolean;
    hasTimeRange: boolean;
    timeRangeStart?: number;
    timeRangeEnd?: number;
    // Info about AI-generated animations on the main timeline
    hasAiAnimationsOnTimeline: boolean;
    selectedClipIsAiAnimation: boolean;
    selectedAiAnimationAssetId?: string;
    timelineSummary: TimelineSummary;
  }

  // Extract a count like "5 animations" or "animations x3" from text
  const extractCountFromText = (text: string, keyword: string): number => {
    const m = text.match(new RegExp(`(\\d+)\\s+${keyword}`, 'i'))
             || text.match(new RegExp(`${keyword}s?\\s+x\\s*(\\d+)`, 'i'));
    return m ? parseInt(m[1]) : 3;
  };

  // Convert a workflow type to a RecipeStep for multi-intent runs
  const workflowToStep = (wf: WorkflowType, text: string): RecipeStep | null => {
    switch (wf) {
      case 'dead-air': return { workflowType: 'dead-air', label: 'Removing dead air...' };
      case 'captions': return { workflowType: 'captions', label: 'Adding captions...' };
      case 'auto-gif': return { workflowType: 'auto-gif', label: 'Adding GIF overlays...' };
      case 'extract-audio': return { workflowType: 'extract-audio', label: 'Extracting audio...' };
      case 'batch-animations': return {
        workflowType: 'batch-animations',
        label: 'Adding animations...',
        count: extractCountFromText(text, 'animation'),
      };
      default: return null;
    }
  };

  // Detect multiple intents in a single prompt (e.g. "remove silence and add captions")
  const detectMultipleIntents = (text: string): RecipeStep[] | null => {
    const hasConnector = /\b(and|then|also|\+|,)\b/i.test(text);
    if (!hasConnector) return null;

    const INTENT_KEYWORDS: Array<[RegExp, WorkflowType]> = [
      [/remove\s+(dead\s+air|silence|gaps?)/i, 'dead-air'],
      [/(add|generate|create)\s+captions?/i, 'captions'],
      [/\d+\s+animations?|add\s+animations?/i, 'batch-animations'],
      [/(add|find|search)\s+gifs?/i, 'auto-gif'],
      [/extract\s+audio/i, 'extract-audio'],
    ];

    const found: WorkflowType[] = [];
    for (const [regex, wf] of INTENT_KEYWORDS) {
      if (regex.test(text) && !found.includes(wf)) found.push(wf);
    }

    if (found.length < 2) return null;
    return found.map(wf => workflowToStep(wf, text)).filter(Boolean) as RecipeStep[];
  };

  const determineWorkflow = (ctx: DirectorContext): WorkflowType => {
    const lower = ctx.prompt.toLowerCase();

    // ============================================
    // AUDIT / CRITIC INTENT — check first
    // ============================================
    if (/\b(audit|critique|rate|assess|what.?s wrong|how.?s my|check my video|analyze my project|how does it look|score my|give me feedback|review my)\b/i.test(lower)) {
      return 'audit';
    }

    // ============================================
    // CONTEXT-AWARE DECISIONS
    // ============================================

    // If user has selected an AI animation clip on the main timeline and wants to edit it
    if (ctx.selectedClipIsAiAnimation && !ctx.isOnEditTab) {
      const isEditIntent = lower.includes('edit') || lower.includes('change') ||
                          lower.includes('modify') || lower.includes('update') ||
                          lower.includes('make it') || lower.includes('adjust') ||
                          lower.includes('add') || lower.includes('remove');
      if (isEditIntent) {
        return 'edit-animation';
      }
    }

    // If on an edit tab with an animation, most prompts are about editing that animation
    // Unless they explicitly ask for something unrelated (like "add captions to my main video")
    if (ctx.isOnEditTab && ctx.editTabHasAnimation) {
      // Check if they're explicitly asking about the main video/timeline
      const isAboutMainVideo = lower.includes('main video') ||
                               lower.includes('main timeline') ||
                               lower.includes('original video');

      // Check if they're asking for something that only applies to video content (not animations)
      const isVideoOnlyFeature = lower.includes('caption') ||
                                 lower.includes('subtitle') ||
                                 lower.includes('dead air') ||
                                 lower.includes('silence') ||
                                 lower.includes('chapter');

      // If not explicitly about main video and not a video-only feature, edit the animation
      if (!isAboutMainVideo && !isVideoOnlyFeature) {
        // This includes: "make it bigger", "change colors", "add more scenes",
        // "make it faster", "add an image", camera movements, etc.
        return 'edit-animation';
      }
    }

    // Camera movement requests (should route to animation workflows)
    const isCameraMovement = lower.includes('zoom') || lower.includes('pan') ||
                             lower.includes('ken burns') || lower.includes('camera') ||
                             lower.includes('shake') || lower.includes('dolly') ||
                             lower.includes('tracking shot') || lower.includes('tilt');

    // If asking for camera movement on an existing animation, edit it
    if (isCameraMovement && (ctx.editTabHasAnimation || ctx.selectedClipIsAiAnimation)) {
      return 'edit-animation';
    }

    // ============================================
    // INTENT-BASED DECISIONS (when not in edit tab)
    // ============================================

    // Caption polish — filler word removal (check before generic caption route)
    if (lower.includes('filler') || lower.includes('remove um') || lower.includes('remove uh') ||
        lower.includes('clean captions') || lower.includes('polish captions') ||
        lower.includes('clean transcript') || lower.includes('polish transcript') ||
        (lower.includes('remove') && (lower.includes('filler') || lower.includes('ums') || lower.includes('uhs'))) ||
        lower.includes('caption cleanup') || lower.includes('caption clean')) {
      return 'caption-polish';
    }

    // Caption-related requests
    if (lower.includes('caption') || lower.includes('subtitle') ||
        lower.includes('transcribe') || lower.includes('transcription')) {
      return 'captions';
    }

    // Dead air / silence removal
    if (lower.includes('dead air') || lower.includes('silence') ||
        lower.includes('remove quiet') || lower.includes('remove pauses')) {
      return 'dead-air';
    }

    // Extract audio from video
    if ((lower.includes('extract') && lower.includes('audio')) ||
        (lower.includes('separate') && lower.includes('audio')) ||
        (lower.includes('split') && lower.includes('audio')) ||
        (lower.includes('remove') && lower.includes('audio') && lower.includes('track')) ||
        (lower.includes('audio') && lower.includes('to') && (lower.includes('a1') || lower.includes('track')))) {
      return 'extract-audio';
    }

    // GIF-related requests — check before chapter-cuts so "add gif at each chapter" picks GIF
    if (lower.includes('gif') || lower.includes('giphy') ||
        (lower.includes('add') && lower.includes('meme'))) {
      return 'auto-gif';
    }

    // B-roll with Remotion -> treat as batch animations
    if ((lower.includes('b-roll') || lower.includes('broll')) &&
        (lower.includes('remotion') || lower.includes('animation'))) {
      return 'batch-animations';
    }

    // B-roll requests (static images)
    if (lower.includes('b-roll') || lower.includes('broll') ||
        lower.includes('stock image') || lower.includes('overlay image')) {
      return 'b-roll';
    }

    // Transcript animation (kinetic typography)
    if ((lower.includes('transcript') && lower.includes('animation')) ||
        lower.includes('kinetic typography') || lower.includes('animate the words') ||
        lower.includes('animate text from speech')) {
      return 'transcript-animation';
    }

    // Motion graphics templates (specific template types)
    if (lower.includes('lower third') || lower.includes('counter') ||
        lower.includes('progress bar') || lower.includes('call to action') ||
        lower.includes('cta') || lower.includes('subscribe button') ||
        lower.includes('logo reveal') || lower.includes('testimonial')) {
      return 'motion-graphics';
    }

    // Contextual animation (based on video content at a specific time)
    if (ctx.hasTimeRange && (lower.includes('animation') || lower.includes('animate') ||
        lower.includes('visual') || lower.includes('graphic'))) {
      return 'contextual-animation';
    }

    // Batch animations (multiple animations across the video) — check before chapter-cuts
    // so "add 5 animations at each chapter" routes here, not to chapter-cuts
    const batchAnimationMatch = lower.match(/(?:add|create|generate|make)\s+(\d+)\s+animation/i) ||
                                lower.match(/(\d+)\s+animation/i);
    if (batchAnimationMatch ||
        (lower.includes('animations') && (lower.includes('throughout') || lower.includes('across') || lower.includes('multiple') || lower.includes('chapter') || lower.includes('each')))) {
      return 'batch-animations';
    }

    // Create new animation (explicit creation requests) — check before chapter-cuts
    // so "create animation for each chapter" routes here
    if ((lower.includes('create') || lower.includes('make') || lower.includes('generate') ||
         lower.includes('add') || lower.includes('build') || lower.includes('design')) &&
        (lower.includes('animation') || lower.includes('animated') || lower.includes('motion') ||
         lower.includes('graphic') || lower.includes('visual') || lower.includes('overlay') ||
         lower.includes('intro') || lower.includes('outro') || lower.includes('title card') ||
         lower.includes('text overlay') || lower.includes('infographic') || lower.includes('scene'))) {
      return 'create-animation';
    }

    // Chapter cuts — only when NOT asking for animations/GIFs
    if (lower.includes('chapter') || lower.includes('split into sections') ||
        lower.includes('segment') || (lower.includes('cut') && lower.includes('topic'))) {
      return 'chapter-cuts';
    }

    // Remotion animation keywords without explicit create/make verbs
    // Things like "a title card showing...", "intro with my logo", "stats animation"
    if (lower.includes('animation') || lower.includes('animated') ||
        lower.includes('title card') || lower.includes('intro ') || lower.includes('outro ') ||
        lower.includes('end screen') || lower.includes('infographic') ||
        lower.includes('text effect') || lower.includes('kinetic text') ||
        lower.includes('data visual') || lower.includes('chart ') || lower.includes('graph ') ||
        lower.includes('countdown') || lower.includes('timer') ||
        lower.includes('logo animation') || lower.includes('logo reveal') ||
        lower.includes('screen mockup') || lower.includes('phone mockup') ||
        lower.includes('social proof') || lower.includes('comparison')) {
      // If we have an animation in context, edit it
      if (ctx.editTabHasAnimation || ctx.selectedClipIsAiAnimation) {
        return 'edit-animation';
      }
      return 'create-animation';
    }

    // Camera movement requests without existing animation -> create new animation
    if (isCameraMovement && (lower.includes('animation') || lower.includes('effect') || lower.includes('add'))) {
      return 'create-animation';
    }

    // Animation editing language when there might be an animation in context
    if (lower.includes('animation') &&
        (lower.includes('change') || lower.includes('modify') || lower.includes('update') ||
         lower.includes('edit') || lower.includes('adjust'))) {
      // If we have an animation asset in the edit tab, edit it
      if (ctx.editTabHasAnimation) {
        return 'edit-animation';
      }
      // Otherwise they might want to create one
      return 'create-animation';
    }

    // Platform presets (intercept before generic ffmpeg-edit)
    const platformMatch = PLATFORM_PRESETS.find(p => p.keywords.some(k => lower.includes(k)));
    if (platformMatch ||
        lower.includes('export for') || lower.includes('optimize for') || lower.includes('format for') ||
        lower.includes('ready for') || (lower.includes('export') && (lower.includes('platform') || lower.includes('social')))) {
      return 'platform-preset';
    }

    // Audio clean — noise reduction (intercept before generic ffmpeg-edit)
    if ((lower.includes('clean') && lower.includes('audio')) ||
        lower.includes('remove noise') || lower.includes('reduce noise') ||
        lower.includes('background noise') || lower.includes('denoise') ||
        lower.includes('noise reduction') || lower.includes('noise clean')) {
      return 'audio-clean';
    }

    // Audio normalize — loudness (intercept before generic ffmpeg-edit)
    if ((lower.includes('normaliz') || lower.includes('normalise')) &&
        (lower.includes('audio') || lower.includes('loud') || lower.includes('sound') || lower.includes('volume')) ||
        lower.includes('too quiet') || lower.includes('too loud') ||
        lower.includes('audio levels') || lower.includes('lufs')) {
      return 'audio-normalize';
    }

    // Filler word audio muting
    if ((lower.includes('mute') || lower.includes('remove') || lower.includes('cut')) &&
        (lower.includes('filler') || lower.includes('um') || lower.includes('uh') ||
         lower.includes('filler word') || lower.includes('verbal tick') || lower.includes('speech habit'))) {
      return 'filler-cut';
    }
    if (lower.includes('mute filler') || lower.includes('cut um') || lower.includes('remove um') ||
        lower.includes('clean speech') || lower.includes('remove uh')) {
      return 'filler-cut';
    }

    // Section resequencing (move X before/after Y)
    if ((lower.includes('move') || lower.includes('swap') || lower.includes('reorder') || lower.includes('rearrange')) &&
        (lower.includes('before') || lower.includes('after') || lower.includes('section') || lower.includes('part'))) {
      return 'resequence';
    }
    if (lower.includes('resequence') || lower.includes('re-sequence') ||
        lower.includes('rearrange sections') || lower.includes('swap sections')) {
      return 'resequence';
    }

    // Scene detection
    if (lower.includes('scene detect') || lower.includes('detect scene') ||
        lower.includes('scene change') || lower.includes('find cut') ||
        lower.includes('find scene') || lower.includes('scene cut')) {
      return 'scene-detect';
    }

    // FFmpeg-style video edits (trim, cut, speed, audio, noise, etc.)
    if (lower.includes('trim') || lower.includes('cut') || lower.includes('speed') ||
        lower.includes('slow') || lower.includes('fast') || lower.includes('reverse') ||
        lower.includes('crop') || lower.includes('rotate') || lower.includes('flip') ||
        lower.includes('brightness') || lower.includes('contrast') || lower.includes('filter') ||
        lower.includes('noise') || lower.includes('denoise') || lower.includes('background noise') ||
        lower.includes('volume') || lower.includes('audio level') || lower.includes('normalize') ||
        lower.includes('fade in') || lower.includes('fade out') || lower.includes('mute') ||
        lower.includes('stabilize') || lower.includes('sharpen') || lower.includes('blur') ||
        lower.includes('saturation') || lower.includes('hue') || lower.includes('exposure') ||
        lower.includes('color correct') || lower.includes('colour correct') ||
        lower.includes('resize') || lower.includes('scale') || lower.includes('compress')) {
      return 'ffmpeg-edit';
    }

    // Default: if nothing matched, treat as an ffmpeg edit (safer than assuming animation)
    return 'ffmpeg-edit';
  };

  // Handle chapter cuts workflow
  const handleChapterCutWorkflow = async () => {
    if (!onChapterCuts) return;

    setIsProcessing(true);
    setProcessingStatus('Analyzing video for chapters...');

    setChatHistory(prev => [...prev, {
      type: 'assistant',
      text: '🎬 Analyzing your video to identify chapters and key sections...',
    }]);

    try {
      setProcessingStatus('Transcribing and identifying chapters...');

      const result = await onChapterCuts();

      // Build chapter list for display
      const chapterList = result.chapters
        .map((ch, i) => {
          const mins = Math.floor(ch.start / 60);
          const secs = Math.floor(ch.start % 60);
          return `${i + 1}. ${mins}:${secs.toString().padStart(2, '0')} - ${ch.title}`;
        })
        .join('\n');

      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `✅ Found ${result.chapters.length} chapters and made ${result.cutsApplied} cuts!\n\nChapters:\n${chapterList}\n\nYour video has been split at each chapter point. You can now rearrange, trim, or delete sections as needed.`,
      }]);

    } catch (error) {
      console.error('Chapter cuts failed:', error);
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `❌ Failed to generate chapter cuts: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }]);
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  // Handle scene detect workflow
  const handleSceneDetectWorkflow = async () => {
    if (!onSceneDetect) return;

    setIsProcessing(true);
    setProcessingStatus('Scanning for scene changes...');

    setChatHistory(prev => [...prev, {
      type: 'assistant',
      text: '🎬 Scanning your video for scene changes...',
    }]);

    try {
      const { scenes } = await onSceneDetect();

      if (scenes.length === 0) {
        setChatHistory(prev => [...prev, {
          type: 'assistant',
          text: 'No scene changes detected. The video may be a single continuous shot.',
        }]);
        return;
      }

      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `Found ${scenes.length} scene change${scenes.length !== 1 ? 's' : ''}. Click "Cut at scenes" to split your video at these points.`,
        sceneDetectResult: { scenes },
      }]);

    } catch (error) {
      console.error('Scene detect failed:', error);
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `❌ Scene detection failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }]);
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  // Handle filler word audio muting
  const handleFillerCutWorkflow = async () => {
    if (!onMuteFillerWords) return;

    setIsProcessing(true);
    setProcessingStatus('Muting filler words...');

    setChatHistory(prev => [...prev, {
      type: 'assistant',
      text: '🔇 Muting filler words (um, uh, like...) in your audio...',
    }]);

    try {
      const { mutedCount } = await onMuteFillerWords(FILLER_WORDS);
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `✅ Muted ${mutedCount} filler word${mutedCount !== 1 ? 's' : ''} in the audio. The video is unchanged — only the sound is silenced at those moments.`,
      }]);
    } catch (error) {
      console.error('Filler cut failed:', error);
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `❌ Filler word muting failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }]);
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  // Handle section resequencing
  const handleResequenceWorkflow = async (userMessage: string) => {
    if (!onResequence) return;

    setIsProcessing(true);
    setProcessingStatus('Analyzing sections...');

    setChatHistory(prev => [...prev, {
      type: 'assistant',
      text: '🔄 Analyzing your video sections...',
    }]);

    try {
      const result = await onResequence(userMessage);

      if (!result.swaps || result.swaps.length === 0) {
        setChatHistory(prev => [...prev, {
          type: 'assistant',
          text: 'I couldn\'t identify the sections you want to move. Try being more specific, e.g. "move the pricing section before the demo section".',
        }]);
        return;
      }

      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: result.explanation || 'Here\'s what I found:',
        resequenceResult: result,
      }]);

    } catch (error) {
      console.error('Resequence failed:', error);
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `❌ Resequencing failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }]);
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  // Poll for job completion
  const pollForResult = async (jobId: string, maxAttempts = 60): Promise<any> => {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      setProcessingStatus(`AI is working... (${attempt + 1}s)`);

      try {
        const response = await fetch(`/api/ai-edit/status/${jobId}`);
        if (!response.ok) {
          throw new Error(`Status check failed: ${response.status}`);
        }

        const data = await response.json();

        if (data.status === 'complete') {
          return data;
        }

        if (data.status === 'error') {
          throw new Error(data.error || 'Processing failed');
        }

        // Still processing, wait and try again
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        // On network error, wait and retry
        console.error('Poll error:', error);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    throw new Error('Request timed out after 60 seconds');
  };

  // Handle the caption workflow
  const handleCaptionWorkflow = async () => {
    if (!onTranscribeAndAddCaptions) return;

    setShowCaptionOptions(false);
    setIsProcessing(true);
    setProcessingStatus('Starting transcription...');

    try {
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `Transcribing your ${formatTimeShort(timelineSummary.videoDuration)} video...${timelineSummary.hasCaptions ? ` Replacing ${timelineSummary.captionCount} existing captions.` : ''}\n\n1. Extracting audio from video\n2. Running local Whisper for accurate timestamps\n3. Adding captions to T1 track\n\nFont: ${captionOptions.fontFamily}\nHighlight: ${captionOptions.highlightColor}`,
        isProcessingGifs: true,
        isCaptionWorkflow: true,
      }]);

      const captionResult = await onTranscribeAndAddCaptions(captionOptions);

      // Update the last message to show completion
      setChatHistory(prev => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (updated[lastIdx]?.isProcessingGifs) {
          updated[lastIdx] = {
            ...updated[lastIdx],
            text: 'Captions generated and added to your timeline! Select a caption clip to customize the style.',
            isProcessingGifs: false,
            applied: true,
            isCaptionWorkflow: true,
            undoData: {
              workflowType: 'captions',
              addedClipIds: (captionResult as { captionClipIds?: string[] } | null)?.captionClipIds ?? [],
            },
          };
        }
        return updated;
      });

    } catch (error) {
      console.error('Caption workflow error:', error);
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}. Make sure the ffmpeg server is running.`,
      }]);
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  // Handle the auto-GIF workflow
  const handleAutoGifWorkflow = async () => {
    if (!onExtractKeywordsAndAddGifs) return;

    setIsProcessing(true);
    setProcessingStatus('Starting keyword extraction...');

    try {
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `Analyzing your ${formatTimeShort(timelineSummary.videoDuration)} video for keywords and brands...\n\n1. Extracting audio and transcribing\n2. Finding keywords and brands\n3. Searching for relevant GIFs\n4. Adding to timeline at correct timestamps`,
        isProcessingGifs: true,
      }]);

      const gifResult = await onExtractKeywordsAndAddGifs();

      // Update the last message to show completion
      setChatHistory(prev => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (updated[lastIdx]?.isProcessingGifs) {
          updated[lastIdx] = {
            ...updated[lastIdx],
            text: 'Keywords extracted, GIFs found, and added to your timeline!',
            isProcessingGifs: false,
            applied: true,
            undoData: {
              workflowType: 'auto-gif',
              addedClipIds: (gifResult as { addedClipIds?: string[] } | null)?.addedClipIds ?? [],
            },
          };
        }
        return updated;
      });

    } catch (error) {
      console.error('Auto-GIF workflow error:', error);
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again.`,
      }]);
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  // Parse prompt and determine motion graphic template
  const parseMotionGraphicFromPrompt = (text: string): MotionGraphicConfig | null => {
    const lower = text.toLowerCase();

    // Lower Third detection
    if (lower.includes('lower third') || lower.includes('lowerthird') || lower.includes('name title')) {
      const nameMatch = text.match(/(?:name|for|called?)\s*[:\-"]?\s*["']?([A-Z][a-zA-Z\s]+?)["']?(?:\s|,|$)/i);
      const titleMatch = text.match(/(?:title|as|position)\s*[:\-"]?\s*["']?([A-Za-z\s&]+?)["']?(?:\s|,|$)/i);

      return {
        templateId: 'lower-third',
        props: {
          ...MOTION_TEMPLATES['lower-third'].defaultProps,
          name: nameMatch?.[1]?.trim() || 'John Doe',
          title: titleMatch?.[1]?.trim() || 'CEO & Founder',
        },
        duration: 4,
        startTime: currentTime,
      };
    }

    // Animated Text detection
    if (lower.includes('animated text') || lower.includes('text animation')) {
      const textMatch = text.match(/(?:text|saying?|with)\s*[:\-"]?\s*["']([^"']+)["']/i) ||
                        text.match(/["']([^"']+)["']/);

      return {
        templateId: 'animated-text',
        props: {
          ...MOTION_TEMPLATES['animated-text'].defaultProps,
          text: textMatch?.[1] || 'Your Text Here',
          style: lower.includes('typewriter') ? 'typewriter' :
                 lower.includes('bounce') ? 'bounce' :
                 lower.includes('glitch') ? 'glitch' :
                 lower.includes('fade') ? 'fade-up' : 'typewriter',
        },
        duration: 3,
        startTime: currentTime,
      };
    }

    // Counter detection
    if (lower.includes('counter') || lower.includes('count up') || lower.includes('number animation')) {
      const valueMatch = text.match(/(\d+(?:,\d{3})*(?:\.\d+)?)/);
      const labelMatch = text.match(/(?:label|for|showing)\s*[:\-"]?\s*["']?([A-Za-z\s]+?)["']?(?:\s|,|$)/i);

      return {
        templateId: 'counter',
        props: {
          ...MOTION_TEMPLATES['counter'].defaultProps,
          value: valueMatch ? parseInt(valueMatch[1].replace(/,/g, '')) : 10000,
          label: labelMatch?.[1]?.trim() || 'Total Users',
          suffix: lower.includes('+') || lower.includes('plus') ? '+' : '',
          prefix: lower.includes('$') || lower.includes('dollar') ? '$' : '',
        },
        duration: 3,
        startTime: currentTime,
      };
    }

    // Progress Bar detection
    if (lower.includes('progress bar') || lower.includes('loading bar')) {
      const percentMatch = text.match(/(\d+)\s*%/);
      const labelMatch = text.match(/(?:label|for|showing)\s*[:\-"]?\s*["']?([A-Za-z\s]+?)["']?(?:\s|,|$)/i);

      return {
        templateId: 'progress-bar',
        props: {
          ...MOTION_TEMPLATES['progress-bar'].defaultProps,
          progress: percentMatch ? parseInt(percentMatch[1]) : 75,
          label: labelMatch?.[1]?.trim() || 'Progress',
          style: lower.includes('circular') ? 'circular' :
                 lower.includes('neon') ? 'neon' : 'linear',
        },
        duration: 3,
        startTime: currentTime,
      };
    }

    // Call to Action detection
    if (lower.includes('call to action') || lower.includes('cta') ||
        lower.includes('subscribe button') || lower.includes('like button')) {
      return {
        templateId: 'call-to-action',
        props: {
          ...MOTION_TEMPLATES['call-to-action'].defaultProps,
          type: lower.includes('like') ? 'like' :
                lower.includes('follow') ? 'follow' :
                lower.includes('share') ? 'share' : 'subscribe',
        },
        duration: 3,
        startTime: currentTime,
      };
    }

    // Logo Reveal detection
    if (lower.includes('logo reveal') || lower.includes('logo animation') ||
        lower.includes('intro animation') || lower.includes('outro')) {
      const logoMatch = text.match(/(?:logo|brand|text)\s*[:\-"]?\s*["']?([A-Za-z0-9\s]+?)["']?(?:\s|,|$)/i);
      const taglineMatch = text.match(/(?:tagline|slogan)\s*[:\-"]?\s*["']([^"']+)["']/i);

      return {
        templateId: 'logo-reveal',
        props: {
          ...MOTION_TEMPLATES['logo-reveal'].defaultProps,
          logoText: logoMatch?.[1]?.trim() || 'LOGO',
          tagline: taglineMatch?.[1] || 'Your tagline here',
          style: lower.includes('glitch') ? 'glitch' :
                 lower.includes('scale') ? 'scale' :
                 lower.includes('slide') ? 'slide' : 'scale',
        },
        duration: 4,
        startTime: currentTime,
      };
    }

    // Screen Frame / Mockup detection
    if (lower.includes('mockup') || lower.includes('screen frame') || lower.includes('device frame')) {
      return {
        templateId: 'screen-frame',
        props: {
          ...MOTION_TEMPLATES['screen-frame'].defaultProps,
          frameType: lower.includes('phone') || lower.includes('mobile') ? 'phone' :
                     lower.includes('tablet') || lower.includes('ipad') ? 'tablet' :
                     lower.includes('desktop') ? 'desktop' : 'browser',
          style: lower.includes('light') ? 'light' : 'dark',
        },
        duration: 4,
        startTime: currentTime,
      };
    }

    // Testimonial / Social Proof detection
    if (lower.includes('testimonial') || lower.includes('social proof') || lower.includes('rating')) {
      const quoteMatch = text.match(/["']([^"']+)["']/);
      const authorMatch = text.match(/(?:by|from|author)\s*[:\-"]?\s*["']?([A-Z][a-zA-Z\s]+?)["']?(?:\s|,|$)/i);

      return {
        templateId: 'social-proof',
        props: {
          ...MOTION_TEMPLATES['social-proof'].defaultProps,
          type: lower.includes('rating') ? 'rating' :
                lower.includes('stats') ? 'stats' : 'testimonial',
          quote: quoteMatch?.[1] || '"This product changed everything for us."',
          author: authorMatch?.[1]?.trim() || 'Jane Doe',
        },
        duration: 5,
        startTime: currentTime,
      };
    }

    // Comparison detection
    if (lower.includes('before after') || lower.includes('comparison') || lower.includes('versus')) {
      return {
        templateId: 'comparison',
        props: {
          ...MOTION_TEMPLATES['comparison'].defaultProps,
          type: lower.includes('slide') ? 'slider' :
                lower.includes('flip') ? 'flip' :
                lower.includes('fade') ? 'fade' : 'side-by-side',
        },
        duration: 5,
        startTime: currentTime,
      };
    }

    // Data Chart detection
    if (lower.includes('chart') || lower.includes('data visualization') || lower.includes('graph')) {
      return {
        templateId: 'data-chart',
        props: {
          ...MOTION_TEMPLATES['data-chart'].defaultProps,
          type: lower.includes('pie') ? 'pie' :
                lower.includes('donut') ? 'donut' :
                lower.includes('line') ? 'line' : 'bar',
          title: 'Monthly Revenue',
        },
        duration: 4,
        startTime: currentTime,
      };
    }

    return null;
  };

  // Handle custom AI-generated animation workflow
  const handleCustomAnimationWorkflow = async (description: string, startTimeOverride?: number, endTimeOverride?: number) => {
    // Parse duration from the description if user specified one
    const requestedDuration = parseDurationFromPrompt(description);

    // Debug: log what time values we received
    console.log('[DEBUG] handleCustomAnimationWorkflow called with:', JSON.stringify({ description: description.substring(0, 50), startTimeOverride, endTimeOverride, requestedDuration }));

    // When a time range is specified, use the contextual workflow with approval step
    // This analyzes the video content and shows scenes for user review before rendering
    if (startTimeOverride !== undefined && onAnalyzeForAnimation) {
      setIsProcessing(true);
      setProcessingStatus('Analyzing video content...');

      try {
        const timeStr = formatTimeShort(startTimeOverride);
        const endTimeStr = endTimeOverride !== undefined ? formatTimeShort(endTimeOverride) : '';
        const rangeStr = endTimeOverride !== undefined ? `${timeStr} - ${endTimeStr}` : timeStr;

        setChatHistory(prev => [...prev, {
          type: 'assistant',
          text: `🎬 Analyzing video segment ${rangeStr} for: "${description}"\n\n1. Extracting audio from ${rangeStr}\n2. Transcribing ONLY that segment\n3. Understanding what's being discussed\n4. Designing relevant animation scenes\n\nYou'll be able to review and approve the scenes before rendering...`,
          isProcessingGifs: true,
        }]);

        // Build time range - use provided end time, or create a 20s window around the start time
        const timeRangeToUse = endTimeOverride !== undefined
          ? { start: startTimeOverride, end: endTimeOverride }
          : { start: Math.max(0, startTimeOverride - 5), end: startTimeOverride + 15 }; // Default 20s window around timestamp

        // Debug: log the time range being passed to analysis
        console.log('[DEBUG] Calling onAnalyzeForAnimation with timeRange:', JSON.stringify(timeRangeToUse));

        // Analyze video to get concept - pass description and time range for context
        // The time range ensures only that segment's transcript is analyzed
        const { concept } = await onAnalyzeForAnimation({
          type: 'highlight',
          description: `At timestamp ${timeStr}: ${description}`,
          timeRange: timeRangeToUse,
        });

        // Store the concept with the start time for when it's approved
        const conceptWithTime = { ...concept, startTime: startTimeOverride };
        setPendingAnimationConcept(conceptWithTime);

        // Show the concept for approval
        setChatHistory(prev => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          if (updated[lastIdx]?.isProcessingGifs) {
            updated[lastIdx] = {
              ...updated[lastIdx],
              text: `📋 Animation Concept Ready (for ${rangeStr})\n\nContent Summary: ${concept.contentSummary}\n\nKey Topics: ${concept.keyTopics.join(', ')}\n\nProposed Scenes (${concept.scenes.length}):\n${concept.scenes.map((s, i) => `${i + 1}. ${s.type}: ${s.content.title || s.content.subtitle || 'Visual'} (${s.duration}s)`).join('\n')}\n\nTotal Duration: ${concept.totalDuration}s\n\n👇 Review and approve below, or cancel to modify your request.`,
              isProcessingGifs: false,
            };
          }
          return updated;
        });

      } catch (error) {
        console.error('Custom animation analysis error:', error);
        setChatHistory(prev => [...prev, {
          type: 'assistant',
          text: `❌ Failed to analyze video: ${error instanceof Error ? error.message : 'Unknown error'}\n\nTry a different description or check that your video has audio.`,
        }]);
      } finally {
        setIsProcessing(false);
        setProcessingStatus('');
      }
      return;
    }

    // For requests without time range, render directly (but still get video context)
    if (!onCreateCustomAnimation) return;

    setIsProcessing(true);
    setProcessingStatus('Generating custom animation with AI...');

    // Capture current attachments before clearing
    const currentAttachments = [...attachedAssets];
    const attachedAssetIds = currentAttachments.map(a => a.id);

    try {
      const hasTimeRange = startTimeOverride !== undefined;
      const hasAttachments = currentAttachments.length > 0;

      let statusMessage = `🎬 Creating custom animation${requestedDuration ? ` (${requestedDuration}s)` : ''}...\n\n`;
      statusMessage += `1. ${hasTimeRange ? 'Using specified time range for context' : 'Analyzing video transcript for context'}\n`;
      if (requestedDuration) {
        statusMessage += `2. Target duration: ${requestedDuration} seconds\n`;
      }
      if (hasAttachments) {
        statusMessage += `${requestedDuration ? '3' : '2'}. Including ${currentAttachments.length} attached asset(s): ${currentAttachments.map(a => a.filename).join(', ')}\n`;
        statusMessage += `${requestedDuration ? '4' : '3'}. Generating Remotion component with AI\n${requestedDuration ? '5' : '4'}. Rendering animation to video\n${requestedDuration ? '6' : '5'}. Adding to timeline`;
      } else {
        statusMessage += `${requestedDuration ? '3' : '2'}. Generating Remotion component with AI\n${requestedDuration ? '4' : '3'}. Rendering animation to video\n${requestedDuration ? '5' : '4'}. Adding to timeline`;
      }
      statusMessage += `\n\nThis may take a moment...`;

      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: statusMessage,
        isProcessingGifs: true,
      }]);

      // Pass time range, attached assets, and duration to the animation generator
      const result = await onCreateCustomAnimation(description, startTimeOverride, endTimeOverride, attachedAssetIds.length > 0 ? attachedAssetIds : undefined, requestedDuration);

      // Clear attachments after successful creation
      clearAttachments();

      // Update the last message to show completion with edit-in-tab option
      setChatHistory(prev => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (updated[lastIdx]?.isProcessingGifs) {
          updated[lastIdx] = {
            ...updated[lastIdx],
            text: `✅ Custom animation created and added to your timeline!\n\nDuration: ${result.duration}s${hasAttachments ? `\nIncluded assets: ${currentAttachments.map(a => a.filename).join(', ')}` : ''}\n\nThe AI-generated animation is now on your V2 overlay track.`,
            isProcessingGifs: false,
            applied: true,
            animationAssetId: result.assetId,
            animationName: 'Custom Animation',
          };
        }
        return updated;
      });

    } catch (error) {
      console.error('Custom animation workflow error:', error);
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `❌ Failed to create animation: ${error instanceof Error ? error.message : 'Unknown error'}\n\nTry simplifying your description or being more specific about what you want to animate.`,
      }]);
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  // Handle editing an existing animation (when on an edit tab)
  const handleEditAnimationWorkflow = async (editPrompt: string, assetId: string) => {
    if (!onEditAnimation) return;

    setIsProcessing(true);
    setProcessingStatus('Editing animation with AI...');

    try {
      // Get the animation asset for display
      const animationAsset = assets.find(a => a.id === assetId);
      const animationName = animationAsset?.filename || 'Animation';

      // Build context message showing what the AI has access to
      let contextInfo = '1. Loading current animation structure\n2. Applying your changes with AI\n3. Re-rendering animation';
      if (editTabV1Context) {
        contextInfo = `1. Loading current animation structure\n2. Using V1 context: "${editTabV1Context.filename}"\n3. Applying your changes with AI\n4. Re-rendering animation`;
      }

      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `🎨 Editing "${animationName}"...\n\n${contextInfo}\n\nThis may take a moment...`,
        isProcessingGifs: true,
      }]);

      // Pass V1 context if available (hybrid approach) and the tab ID to update
      console.log('[handleEditAnimationWorkflow] Calling onEditAnimation with:', {
        assetId,
        editPrompt: editPrompt.substring(0, 50) + '...',
        hasV1Context: !!editTabV1Context,
        activeTabId,
      });

      const result = await onEditAnimation(assetId, editPrompt, editTabV1Context || undefined, activeTabId);

      console.log('[handleEditAnimationWorkflow] Edit complete:', {
        resultAssetId: result.assetId,
        originalAssetId: assetId,
        isSameAsset: result.assetId === assetId,
        duration: result.duration,
        sceneCount: result.sceneCount,
      });

      // Update the last message to show completion
      // Note: Animation is edited in-place (same asset ID), so no need for "open in tab" button
      setChatHistory(prev => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (updated[lastIdx]?.isProcessingGifs) {
          updated[lastIdx] = {
            ...updated[lastIdx],
            text: `✅ Animation updated in place!\n\nDuration: ${result.duration}s\nScenes: ${result.sceneCount}\n\nYou can continue editing with more prompts.`,
            isProcessingGifs: false,
            applied: true,
            isInPlaceEdit: true, // Flag to indicate this was an in-place edit (no "open in tab" button)
          };
        }
        return updated;
      });

    } catch (error) {
      console.error('Edit animation workflow error:', error);
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `❌ Failed to edit animation: ${error instanceof Error ? error.message : 'Unknown error'}\n\nTry a simpler edit request or check that the animation is AI-generated.`,
      }]);
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  // Handle the motion graphics workflow
  const handleMotionGraphicsWorkflow = async (prompt: string, startTimeOverride?: number) => {
    if (!onAddMotionGraphic) return;

    setIsProcessing(true);
    setProcessingStatus('Parsing motion graphic request...');

    try {
      const config = parseMotionGraphicFromPrompt(prompt);

      if (!config) {
        setChatHistory(prev => [...prev, {
          type: 'assistant',
          text: `I couldn't determine which motion graphic to create. Try being more specific, like:\n\n• "Add a lower third for John Smith, CEO"\n• "Add an animated counter showing 10,000+"\n• "Add a subscribe button call to action"\n• "Add a testimonial quote"`,
        }]);
        return;
      }

      // Use time range start if provided, otherwise use the config's startTime
      if (startTimeOverride !== undefined) {
        config.startTime = startTimeOverride;
      }

      const templateInfo = MOTION_TEMPLATES[config.templateId];

      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `Adding ${templateInfo.name} to your timeline at ${formatTimeShort(config.startTime || 0)}...`,
        isProcessingGifs: true,
      }]);

      await onAddMotionGraphic(config);

      // Update the last message to show completion
      setChatHistory(prev => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (updated[lastIdx]?.isProcessingGifs) {
          updated[lastIdx] = {
            ...updated[lastIdx],
            text: `✅ Added ${templateInfo.name} to your timeline!\n\nYou can select the clip in the timeline to customize its properties.`,
            isProcessingGifs: false,
            applied: true,
          };
        }
        return updated;
      });

    } catch (error) {
      console.error('Motion graphics workflow error:', error);
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again.`,
      }]);
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  // Handle the B-roll image workflow
  const handleBrollWorkflow = async () => {
    if (!onGenerateBroll) return;

    setIsProcessing(true);
    setProcessingStatus('Starting B-roll generation...');

    try {
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: 'Generating AI B-roll images for your video...\n\n1. Transcribing video content\n2. Identifying key moments for visuals\n3. Generating images with Gemini Imagen\n4. Adding to V3 track at correct timestamps',
        isProcessingGifs: true,
        isBrollWorkflow: true,
      }]);

      await onGenerateBroll();

      // Update the last message to show completion
      setChatHistory(prev => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (updated[lastIdx]?.isProcessingGifs) {
          updated[lastIdx] = {
            ...updated[lastIdx],
            text: 'B-roll images generated and added to your timeline on V3 track!',
            isProcessingGifs: false,
            applied: true,
          };
        }
        return updated;
      });

    } catch (error) {
      console.error('B-roll workflow error:', error);
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again.`,
      }]);
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  // Handle dead air removal workflow
  const handleDeadAirWorkflow = async () => {
    if (!onRemoveDeadAir) return;

    setIsProcessing(true);
    setProcessingStatus('Detecting silence...');

    try {
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: '🔇 Analyzing video for dead air and silence...\n\n1. Detecting silent periods\n2. Identifying audio gaps\n3. Removing dead air\n4. Concatenating remaining segments',
        isProcessingGifs: true,
      }]);

      const result = await onRemoveDeadAir();

      // Update the last message to show completion
      setChatHistory(prev => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (updated[lastIdx]?.isProcessingGifs) {
          const message = result.removedDuration > 0
            ? `✅ Dead air removed!\n\nRemoved: ${result.removedDuration.toFixed(1)} seconds of silence\nNew duration: ${result.duration.toFixed(1)} seconds`
            : '✅ No significant silence detected in your video.';
          updated[lastIdx] = {
            ...updated[lastIdx],
            text: message,
            isProcessingGifs: false,
            applied: true,
            isDeadAirWorkflow: true,
          };
        }
        return updated;
      });

    } catch (error) {
      console.error('Dead air removal error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      // Check for the specific "files no longer exist" error
      const isSessionExpired = errorMessage.includes('no longer exist') || errorMessage.includes('ASSET_FILE_MISSING');
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: isSessionExpired
          ? '❌ Session expired - your video files are no longer available. Please re-upload your video and try again.'
          : `❌ Error: ${errorMessage}. Please try again.`,
      }]);
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  // Handle transcript animation workflow (kinetic typography from speech)
  const handleTranscriptAnimationWorkflow = async () => {
    if (!onGenerateTranscriptAnimation) return;

    setIsProcessing(true);
    setProcessingStatus('Analyzing transcript for animation...');

    try {
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: '🎬 Creating kinetic typography animation from your video...\n\n1. Transcribing video with word timestamps\n2. Identifying key phrases to animate\n3. Generating animated text scenes\n4. Rendering with Remotion\n\nThis may take a moment...',
        isProcessingGifs: true,
      }]);

      const result = await onGenerateTranscriptAnimation();

      // Update the last message to show completion with edit-in-tab option
      setChatHistory(prev => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (updated[lastIdx]?.isProcessingGifs) {
          updated[lastIdx] = {
            ...updated[lastIdx],
            text: `✅ Transcript animation created!\n\nDuration: ${result.duration}s\n\nAnimated text overlay has been added to your timeline (V2 track).`,
            isProcessingGifs: false,
            applied: true,
            animationAssetId: result.assetId,
            animationName: 'Transcript Animation',
          };
        }
        return updated;
      });

    } catch (error) {
      console.error('Transcript animation error:', error);
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `❌ Failed to create transcript animation: ${error instanceof Error ? error.message : 'Unknown error'}\n\nMake sure you have a video uploaded and the FFmpeg server is running.`,
      }]);
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  // Handle batch animation generation — uses storyboard preview if available
  const handleBatchAnimationsWorkflow = async (count: number) => {
    const previewFn = onPreviewBatchAnimations ?? onGenerateBatchAnimations;
    if (!previewFn) return;

    setIsProcessing(true);
    setProcessingStatus('Planning animations...');

    try {
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: (() => {
          const contextParts = [
            timelineSummary.hasCaptions ? `${timelineSummary.captionCount} captions` : '',
            timelineSummary.hasAnimations ? `${timelineSummary.animationCount} existing animations` : '',
          ].filter(Boolean).join(', ');
          const alreadyHas = contextParts ? ` (already has ${contextParts})` : '';
          return `🎬 Generating ${count} animations for your ${formatTimeShort(timelineSummary.videoDuration)} video${alreadyHas}...\n\n1. Transcribing video to understand content\n2. Planning strategic animation placements\n3. Generating ${count} unique animations\n\nThis may take a while...`;
        })(),
        isProcessingGifs: true,
      }]);

      const result = await previewFn(count);

      if (onPreviewBatchAnimations) {
        // Storyboard mode: show thumbnails for approval
        setChatHistory(prev => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          if (updated[lastIdx]?.isProcessingGifs) {
            updated[lastIdx] = {
              ...updated[lastIdx],
              text: `Generated ${result.animations.length} animations. Preview below — apply to timeline?`,
              isProcessingGifs: false,
              pendingBatchAnimations: result.animations,
            };
          }
          return updated;
        });
      } else {
        // Legacy mode (no preview prop): auto-apply
        const animationList = result.animations
          .map((a, i) => `${i + 1}. ${a.type} at ${formatTimeShort(a.startTime)}: "${a.title}" (${a.duration.toFixed(1)}s)`)
          .join('\n');
        const addedClipIds = (result as { addedClipIds?: string[] }).addedClipIds ?? [];

        setChatHistory(prev => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          if (updated[lastIdx]?.isProcessingGifs) {
            updated[lastIdx] = {
              ...updated[lastIdx],
              text: `✅ Generated ${result.animations.length} animations!\n\nAnimations added to your timeline:\n${animationList}\n\nVideo duration: ${result.videoDuration.toFixed(1)}s\n\nYou can edit individual animations by selecting them on the timeline.`,
              isProcessingGifs: false,
              applied: true,
              undoData: addedClipIds.length > 0 ? { workflowType: 'batch-animations', addedClipIds } : undefined,
            };
          }
          return updated;
        });
      }

    } catch (error) {
      console.error('Batch animations error:', error);
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `❌ Failed to generate animations: ${error instanceof Error ? error.message : 'Unknown error'}\n\nMake sure you have a video uploaded and the FFmpeg server is running.`,
      }]);
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  // Apply storyboard-previewed animations to the timeline
  const handleApplyStoryboardAnimations = async (idx: number) => {
    const msg = chatHistory[idx];
    if (!msg.pendingBatchAnimations || !onApplyBatchAnimations) return;
    setIsProcessing(true);
    try {
      const result = await onApplyBatchAnimations(msg.pendingBatchAnimations);
      setChatHistory(prev => prev.map((m, i) => {
        if (i !== idx) return m;
        const animList = msg.pendingBatchAnimations!
          .map((a, j) => `${j + 1}. ${a.type} at ${formatTimeShort(a.startTime)}: "${a.title}" (${a.duration.toFixed(1)}s)`)
          .join('\n');
        return {
          ...m,
          text: `✅ Added ${msg.pendingBatchAnimations!.length} animations to timeline!\n\n${animList}`,
          batchAnimationsApplied: true,
          applied: true,
          undoData: result.addedClipIds.length > 0
            ? { workflowType: 'batch-animations' as const, addedClipIds: result.addedClipIds }
            : undefined,
        };
      }));
    } catch (error) {
      console.error('Apply animations error:', error);
    } finally {
      setIsProcessing(false);
    }
  };

  // Cancel storyboard preview (dismiss without adding to timeline)
  const handleCancelStoryboardAnimations = (idx: number) => {
    setChatHistory(prev => prev.map((m, i) =>
      i === idx ? { ...m, batchAnimationsApplied: true, text: 'Animation preview cancelled.' } : m
    ));
  };

  // Undo an applied workflow (removes added clips)
  const handleUndo = async (idx: number) => {
    const msg = chatHistory[idx];
    if (!msg.undoData || msg.undone) return;
    setIsProcessing(true);
    try {
      await onUndoWorkflow?.(msg.undoData);
      setChatHistory(prev => prev.map((m, i) => i === idx ? { ...m, undone: true } : m));
    } finally {
      setIsProcessing(false);
    }
  };

  // Handle extract audio workflow (separates audio to A1 track, mutes video)
  const handleExtractAudioWorkflow = async () => {
    if (!onExtractAudio) return;

    setIsProcessing(true);
    setProcessingStatus('Extracting audio...');

    try {
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `🎵 Extracting audio from your ${formatTimeShort(timelineSummary.videoDuration)} video...\n\n1. Extracting audio track to separate file\n2. Creating muted version of video\n3. Adding audio to A1 track\n4. Replacing video with muted version\n\nThis will give you independent control over video and audio.`,
        isProcessingGifs: true,
      }]);

      const result = await onExtractAudio();

      // Update the last message to show completion
      setChatHistory(prev => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (updated[lastIdx]?.isProcessingGifs) {
          updated[lastIdx] = {
            ...updated[lastIdx],
            text: `✅ Audio extracted successfully!\n\n🎵 Audio: "${result.audioAsset.filename}" (${result.audioAsset.duration.toFixed(1)}s) → Added to A1 track\n🎬 Video: "${result.mutedVideoAsset.filename}" → Replaced original (now muted)\n\nYou can now edit video and audio independently!`,
            isProcessingGifs: false,
            applied: true,
            undoData: result.addedA1ClipId ? {
              workflowType: 'extract-audio',
              addedClipIds: [result.addedA1ClipId],
              modifiedV1ClipId: result.modifiedV1ClipId,
              originalV1AssetId: result.originalV1AssetId,
            } : undefined,
          };
        }
        return updated;
      });

    } catch (error) {
      console.error('Extract audio error:', error);
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `❌ Failed to extract audio: ${error instanceof Error ? error.message : 'Unknown error'}\n\nMake sure you have a video uploaded and the FFmpeg server is running.`,
      }]);
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  // Run a front-end audit of the timeline and return prioritised results
  const runAudit = (): AuditResult[] => {
    const s = timelineSummary;
    const results: AuditResult[] = [];

    if (s.isEmptyTimeline) {
      results.push({ severity: 'warning', message: 'Timeline is empty — no clips or edits added yet' });
      return results;
    }

    // Warnings
    if (!s.hasCaptions) {
      results.push({
        severity: 'warning',
        message: '85% of viewers watch without sound — no captions yet',
        fixLabel: 'Add Captions',
        fixWorkflow: 'captions',
      });
    }

    if (!s.hasAnimations && !s.hasGifs && !s.hasBroll) {
      results.push({
        severity: 'info',
        message: 'No visual overlays — animations or GIFs help retain viewer attention',
        fixLabel: 'Add 3 Animations',
        fixWorkflow: 'batch-animations',
      });
    } else {
      if (!s.hasAnimations && (s.hasGifs || s.hasBroll)) {
        results.push({
          severity: 'info',
          message: 'No animations on V2 — motion graphics can boost production value',
          fixLabel: 'Add Animations',
          fixWorkflow: 'batch-animations',
        });
      }
      if (!s.hasGifs && !s.hasBroll && s.hasAnimations) {
        results.push({
          severity: 'info',
          message: 'No GIF overlays or B-roll — visual variety improves watch time',
          fixLabel: 'Add GIFs',
          fixWorkflow: 'auto-gif',
        });
      }
    }

    if (!s.hasAudioTrack) {
      results.push({
        severity: 'info',
        message: 'Audio is embedded in the video track — extract to A1 for independent mixing',
        fixLabel: 'Extract Audio',
        fixWorkflow: 'extract-audio',
      });
    }

    // Positives
    if (s.hasCaptions) {
      results.push({ severity: 'good', message: `${s.captionCount} captions on T1 — great for accessibility and SEO` });
    }
    if (s.hasAnimations) {
      results.push({ severity: 'good', message: `${s.animationCount} animation${s.animationCount !== 1 ? 's' : ''} on V2 — strong visual engagement` });
    }
    if (s.hasGifs || s.hasBroll) {
      const count = s.gifCount + s.brollCount;
      results.push({ severity: 'good', message: `${count} visual overlay${count !== 1 ? 's' : ''} adding variety` });
    }
    if (s.hasAudioTrack) {
      results.push({ severity: 'good', message: 'Audio extracted to A1 — full mixing control' });
    }

    // Duration
    if (s.videoDuration > 0 && s.videoDuration < 30) {
      results.push({ severity: 'info', message: `Video is only ${formatTimeShort(s.videoDuration)} — very short, make sure this is intentional` });
    } else if (s.videoDuration >= 480) {
      results.push({ severity: 'good', message: `${formatTimeShort(s.videoDuration)} — over 8 min, eligible for YouTube mid-roll ads` });
    } else if (s.videoDuration > 0) {
      results.push({ severity: 'good', message: `${formatTimeShort(s.videoDuration)} — solid length for engagement` });
    }

    return results;
  };

  // Trigger a fix workflow from an audit result button
  const handleAuditFix = (fixWorkflow: NonNullable<AuditResult['fixWorkflow']>) => {
    switch (fixWorkflow) {
      case 'captions': handleCaptionWorkflow(); break;
      case 'batch-animations': handleBatchAnimationsWorkflow(3); break;
      case 'auto-gif': handleAutoGifWorkflow(); break;
      case 'extract-audio': handleExtractAudioWorkflow(); break;
    }
  };

  const executeRecipe = async (recipe: Recipe) => {
    if (isProcessing || !hasVideo) return;
    setShowRecipes(false);
    setIsProcessing(true);

    setChatHistory(prev => [...prev, {
      type: 'assistant',
      text: `⚡ **${recipe.label}** — Step 1/${recipe.steps.length}: ${recipe.steps[0].label}`,
      isProcessingGifs: true,
    }]);

    const completed: string[] = [];

    for (let i = 0; i < recipe.steps.length; i++) {
      const step = recipe.steps[i];

      setChatHistory(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          text: `⚡ **${recipe.label}** — Step ${i + 1}/${recipe.steps.length}: ${step.label}${completed.length > 0 ? '\n\n' + completed.join('\n') : ''}`,
        };
        return updated;
      });

      try {
        switch (step.workflowType) {
          case 'dead-air': {
            const r = await onRemoveDeadAir?.();
            completed.push(`✅ Removed ${r?.removedDuration?.toFixed(1) ?? '?'}s of dead air`);
            break;
          }
          case 'captions': {
            await onTranscribeAndAddCaptions?.();
            completed.push('✅ Captions added');
            break;
          }
          case 'chapter-cuts': {
            const r = await onChapterCuts?.();
            completed.push(`✅ Split into ${r?.chapters?.length ?? '?'} chapters`);
            break;
          }
          case 'batch-animations': {
            const r = await onGenerateBatchAnimations?.(step.count ?? 3);
            completed.push(`✅ Added ${r?.animations?.length ?? '?'} animations`);
            break;
          }
          case 'auto-gif': {
            await onExtractKeywordsAndAddGifs?.();
            completed.push('✅ GIF overlays added');
            break;
          }
          case 'extract-audio': {
            await onExtractAudio?.();
            completed.push('✅ Audio extracted to A1');
            break;
          }
        }
      } catch {
        completed.push(`❌ ${step.label.replace('...', '')} failed`);
        break;
      }
    }

    setChatHistory(prev => {
      const updated = [...prev];
      updated[updated.length - 1] = {
        ...updated[updated.length - 1],
        text: `✅ **${recipe.label}** complete!\n\n${completed.join('\n')}`,
        isProcessingGifs: false,
        applied: true,
      };
      return updated;
    });

    setIsProcessing(false);
  };

  const getWorkflowPreview = (workflow: WorkflowType): { description: string; details: string[] } => {
    const dur = formatTimeShort(timelineSummary.videoDuration);
    switch (workflow) {
      case 'dead-air':
        return {
          description: 'Remove silence from your video',
          details: [
            `Scans ${dur} of audio for pauses ≥ 0.4s below -26 dB`,
            'Cuts each silent segment and re-concatenates the video',
            'Replaces your source file in-place — this cannot be undone',
            timelineSummary.hasCaptions
              ? `Note: ${timelineSummary.captionCount} caption clips may need re-syncing after`
              : 'No captions to worry about',
          ],
        };
      case 'extract-audio':
        return {
          description: 'Separate audio from video onto the A1 track',
          details: [
            'Mutes the V1 video clip',
            'Creates a new audio-only asset on the A1 track',
            'Original video file is not modified',
          ],
        };
      default:
        return { description: 'Run this operation', details: [] };
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;

    const referenceContext = buildReferenceContext();
    const userMessage = prompt.trim();
    const fullMessage = referenceContext + userMessage;

    // Check for time range: first use UI selection, then try to parse from prompt text
    const uiTimeRange = timeRange;
    const promptTimeRange = !uiTimeRange ? parseTimeRangeFromPrompt(userMessage) : undefined;
    const savedTimeRange = uiTimeRange || promptTimeRange; // Use UI selection first, then parsed from prompt

    setPrompt('');
    setSelectedReferences([]); // Clear references after submit
    clearTimeRange(); // Clear time range after submit

    // Add user message to chat (show references and time range as tags visually)
    const timePart = savedTimeRange ? `[${formatTimeShort(savedTimeRange.start)}-${formatTimeShort(savedTimeRange.end)}] ` : '';
    const refPart = selectedReferences.length > 0 ? `${selectedReferences.map(r => `@${r.label}`).join(' ')} ` : '';
    const displayMessage = `${timePart}${refPart}${userMessage}`;
    setChatHistory((prev) => [...prev, { type: 'user', text: displayMessage }]);

    // ===========================================
    // DIRECTOR: Determine the appropriate workflow
    // ===========================================
    const isManualTab = editTabAssetId?.startsWith('edit-') ?? false;
    const animationAsset = (!isManualTab && editTabAssetId) ? assets.find(a => a.id === editTabAssetId) : null;

    // Check if on an animation edit tab - the tab's assetId indicates it was created via "Open in Tab"
    // Trust this even if the asset isn't found in local state (handles timing issues)
    const isOnAnimationEditTab = !isManualTab && !!editTabAssetId;

    // Check aiGenerated flag - use editTabV1Context directly (don't look up asset again, it might fail)
    // This catches both:
    // 1. Tabs created via "Open in Tab" (animationAsset.aiGenerated)
    // 2. Manual tabs where user dragged an AI animation to V1 (editTabV1Context.aiGenerated)
    const editTabHasRemotionAnimation = !!(animationAsset && animationAsset.aiGenerated) ||
                                         !!(editTabV1Context?.aiGenerated);

    // For edit detection: trust either the tab metadata (assetId set) OR the aiGenerated flag
    // This ensures we route to edit-animation even if there's a timing issue with assets state
    const editTabHasAnimation = isOnAnimationEditTab || editTabHasRemotionAnimation;

    // Check for AI-generated animations on the main timeline
    const aiAnimationsOnTimeline = clips
      .map(clip => {
        const asset = assets.find(a => a.id === clip.assetId);
        return asset?.aiGenerated ? { clipId: clip.id, assetId: asset.id, asset } : null;
      })
      .filter(Boolean);
    const hasAiAnimationsOnTimeline = aiAnimationsOnTimeline.length > 0;

    // Check if the currently selected clip is an AI animation
    const selectedClip = selectedClipId ? clips.find(c => c.id === selectedClipId) : null;
    const selectedClipAsset = selectedClip ? assets.find(a => a.id === selectedClip.assetId) : null;
    const selectedClipIsAiAnimation = !!(selectedClipAsset?.aiGenerated);

    const directorContext: DirectorContext = {
      prompt: userMessage,
      isOnEditTab: activeTabId !== 'main',
      editTabHasAnimation,
      editTabAssetId,
      hasVideo: hasVideo ?? false,
      hasTimeRange: !!savedTimeRange,
      timeRangeStart: savedTimeRange?.start,
      timeRangeEnd: savedTimeRange?.end,
      hasAiAnimationsOnTimeline,
      selectedClipIsAiAnimation,
      selectedAiAnimationAssetId: selectedClipIsAiAnimation ? selectedClipAsset?.id : undefined,
      timelineSummary,
    };

    // Check for multiple intents before single-workflow dispatch
    const multiSteps = detectMultipleIntents(userMessage);
    if (multiSteps && multiSteps.length >= 2) {
      const dynamicRecipe: Recipe = { id: 'dynamic', label: 'Custom Edit', description: '', steps: multiSteps };
      await executeRecipe(dynamicRecipe);
      return;
    }

    const workflow = determineWorkflow(directorContext);
    console.log('[Director] Determined workflow:', workflow);
    console.log('[Director] Full context:', {
      prompt: userMessage.substring(0, 50) + '...',
      isOnEditTab: directorContext.isOnEditTab,
      editTabHasAnimation: directorContext.editTabHasAnimation,
      isOnAnimationEditTab,
      editTabHasRemotionAnimation,
      editTabAssetId,
      activeTabId,
      hasTimeRange: directorContext.hasTimeRange,
      animationAssetFound: !!animationAsset,
      animationAssetAiGenerated: animationAsset?.aiGenerated,
      // AI animations on main timeline
      hasAiAnimationsOnTimeline: directorContext.hasAiAnimationsOnTimeline,
      selectedClipIsAiAnimation: directorContext.selectedClipIsAiAnimation,
      selectedAiAnimationAssetId: directorContext.selectedAiAnimationAssetId,
      editTabV1Context: editTabV1Context ? {
        assetId: editTabV1Context.assetId,
        filename: editTabV1Context.filename,
        aiGenerated: editTabV1Context.aiGenerated,
      } : null,
    });

    // ===========================================
    // Execute the determined workflow
    // ===========================================

    // Gate destructive/irreversible workflows with a confirm step
    const CONFIRM_WORKFLOWS: WorkflowType[] = ['dead-air', 'extract-audio'];
    if (CONFIRM_WORKFLOWS.includes(workflow) && hasVideo) {
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: '',
        confirmWorkflow: workflow,
        confirmData: getWorkflowPreview(workflow),
      }]);
      return;
    }

    // Edit existing animation (Remotion)
    // Priority for asset ID:
    // 1. Selected AI animation on main timeline (selectedAiAnimationAssetId)
    // 2. V1 clip's asset ID in edit tab (for manual tabs with dragged animations)
    // 3. editTabAssetId (for tabs created via "Edit in new tab")
    const animationAssetIdToEdit = directorContext.selectedAiAnimationAssetId ||
                                   editTabV1Context?.assetId ||
                                   editTabAssetId;
    if (workflow === 'edit-animation' && animationAssetIdToEdit && onEditAnimation) {
      console.log('[Director] Editing animation with asset ID:', animationAssetIdToEdit);
      console.log('[Director] Source: selectedAiAnimation=%s, editTabV1Context=%s, editTabAssetId=%s',
        directorContext.selectedAiAnimationAssetId,
        editTabV1Context?.assetId,
        editTabAssetId);
      await handleEditAnimationWorkflow(userMessage, animationAssetIdToEdit);
      return;
    }

    // Captions
    if (workflow === 'captions') {
      if (!hasVideo) {
        setChatHistory(prev => [...prev, {
          type: 'assistant',
          text: 'Please upload a video first. I\'ll then transcribe it and add animated captions to your timeline.',
        }]);
        return;
      }
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: 'Configure your caption style below, then click "Add Captions" to start.',
      }]);
      setShowCaptionOptions(true);
      return;
    }

    // Auto-GIF
    if (workflow === 'auto-gif') {
      if (!hasVideo) {
        setChatHistory(prev => [...prev, {
          type: 'assistant',
          text: 'Please upload a video first. I\'ll then extract keywords and add relevant GIFs.',
        }]);
        return;
      }
      await handleAutoGifWorkflow();
      return;
    }

    // B-roll
    if (workflow === 'b-roll') {
      if (!hasVideo) {
        setChatHistory(prev => [...prev, {
          type: 'assistant',
          text: 'Please upload a video first. I\'ll then generate AI B-roll images.',
        }]);
        return;
      }
      await handleBrollWorkflow();
      return;
    }

    // Dead air removal
    if (workflow === 'dead-air') {
      if (!hasVideo) {
        setChatHistory(prev => [...prev, {
          type: 'assistant',
          text: 'Please upload a video first. I\'ll then detect and remove silent periods.',
        }]);
        return;
      }
      await handleDeadAirWorkflow();
      return;
    }

    // Chapter cuts
    if (workflow === 'chapter-cuts') {
      if (!hasVideo) {
        setChatHistory(prev => [...prev, {
          type: 'assistant',
          text: 'Please upload a video first. I\'ll then identify chapters and make cuts.',
        }]);
        return;
      }
      await handleChapterCutWorkflow();
      return;
    }

    // Extract audio from video
    if (workflow === 'extract-audio') {
      if (!hasVideo) {
        setChatHistory(prev => [...prev, {
          type: 'assistant',
          text: 'Please upload a video first. I\'ll then extract the audio to a separate track.',
        }]);
        return;
      }
      await handleExtractAudioWorkflow();
      return;
    }

    // Audit / critic — instant, synchronous, no server call
    if (workflow === 'audit') {
      if (!hasVideo) {
        setChatHistory(prev => [...prev, {
          type: 'assistant',
          text: 'Please upload a video first so I can audit your project.',
        }]);
        return;
      }
      const auditResults = runAudit();
      const issueCount = auditResults.filter(r => r.severity !== 'good').length;
      const goodCount = auditResults.filter(r => r.severity === 'good').length;
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: `🔍 Video Audit — ${issueCount} suggestion${issueCount !== 1 ? 's' : ''}, ${goodCount} ${goodCount !== 1 ? 'things' : 'thing'} looking good`,
        auditResults,
      }]);
      return;
    }

    // Transcript animation (kinetic typography)
    if (workflow === 'transcript-animation') {
      if (!hasVideo) {
        setChatHistory(prev => [...prev, {
          type: 'assistant',
          text: 'Please upload a video first. I\'ll then create animated text from speech.',
        }]);
        return;
      }
      await handleTranscriptAnimationWorkflow();
      return;
    }

    // Batch animations (multiple animations across the video)
    if (workflow === 'batch-animations') {
      if (!hasVideo) {
        setChatHistory(prev => [...prev, {
          type: 'assistant',
          text: 'Please upload a video first. I\'ll then analyze it and generate multiple animations.',
        }]);
        return;
      }
      // Extract count from prompt (e.g., "add 5 animations" -> 5)
      const countMatch = userMessage.toLowerCase().match(/(\d+)\s*animation/);
      const count = countMatch ? parseInt(countMatch[1], 10) : 5; // Default to 5 if no number specified
      await handleBatchAnimationsWorkflow(count);
      return;
    }

    // Contextual animation (based on video content at specific time)
    if (workflow === 'contextual-animation') {
      const contextualCheck = isContextualAnimationPrompt(userMessage);
      if (contextualCheck.isMatch) {
        await handleContextualAnimationWorkflow(contextualCheck.type, userMessage, savedTimeRange ?? undefined);
        return;
      }
      // Fall through to create-animation if contextual check didn't match
      await handleCustomAnimationWorkflow(userMessage, savedTimeRange?.start, savedTimeRange?.end);
      return;
    }

    // Create new animation (Remotion)
    if (workflow === 'create-animation') {
      await handleCustomAnimationWorkflow(userMessage, savedTimeRange?.start, savedTimeRange?.end);
      return;
    }

    // Motion graphics templates
    if (workflow === 'motion-graphics') {
      await handleMotionGraphicsWorkflow(userMessage, savedTimeRange?.start);
      return;
    }

    // Platform preset (instant — pre-built FFmpeg command)
    if (workflow === 'platform-preset') {
      const lower = userMessage.toLowerCase();
      const platform = PLATFORM_PRESETS.find(p => p.keywords.some(k => lower.includes(k))) ?? PLATFORM_PRESETS[0];
      handlePlatformPresetWorkflow(platform);
      return;
    }

    // Caption polish — filler word removal (instant, no AI needed)
    if (workflow === 'caption-polish') {
      handleCaptionPolishWorkflow();
      return;
    }

    // Audio clean (instant — no AI needed)
    if (workflow === 'audio-clean') {
      handleAudioCleanWorkflow();
      return;
    }

    // Audio normalize (instant — no AI needed)
    if (workflow === 'audio-normalize') {
      handleAudioNormalizeWorkflow();
      return;
    }

    // Scene detect
    if (workflow === 'scene-detect') {
      if (!hasVideo) {
        setChatHistory(prev => [...prev, {
          type: 'assistant',
          text: 'Please upload a video first. I\'ll then scan it for scene changes.',
        }]);
        return;
      }
      await handleSceneDetectWorkflow();
      return;
    }

    // Filler word audio muting
    if (workflow === 'filler-cut') {
      if (!hasVideo) {
        setChatHistory(prev => [...prev, {
          type: 'assistant',
          text: 'Please upload a video first, then add captions so I can locate filler words.',
        }]);
        return;
      }
      await handleFillerCutWorkflow();
      return;
    }

    // Section resequencing
    if (workflow === 'resequence') {
      if (!hasVideo) {
        setChatHistory(prev => [...prev, {
          type: 'assistant',
          text: 'Please upload a video and add captions first so I can identify sections.',
        }]);
        return;
      }
      await handleResequenceWorkflow(userMessage);
      return;
    }

    // FFmpeg video edit (default for video manipulation)
    setIsProcessing(true);
    setProcessingStatus('Starting AI...');

    try {
      // Start the job - use fullMessage which includes reference context
      const startResponse = await fetch('/api/ai-edit/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: fullMessage }),
      });

      if (!startResponse.ok) {
        const errorText = await startResponse.text();
        console.error('Start error:', startResponse.status, errorText);
        throw new Error(`Failed to start: ${startResponse.status}`);
      }

      const { jobId } = await startResponse.json();

      if (!jobId) {
        throw new Error('No job ID returned');
      }

      // Poll for the result
      const data = await pollForResult(jobId);

      setChatHistory((prev) => [
        ...prev,
        {
          type: 'assistant',
          text: data.explanation,
          command: data.command,
          explanation: data.explanation,
          applied: false,
        },
      ]);
    } catch (error) {
      console.error('AI request error:', error);
      setChatHistory((prev) => [
        ...prev,
        {
          type: 'assistant',
          text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again.`,
        },
      ]);
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  const FILLER_WORDS = new Set([
    'um', 'uh', 'hmm', 'hm', 'mhm', 'uh-huh',
    'like', 'basically', 'literally', 'actually',
    'right', 'okay', 'ok', 'so', 'well',
    'you', 'know', 'mean', // catches "you know" / "i mean" per-word
  ]);

  const handleCaptionPolishWorkflow = () => {
    const t1Clips = clips.filter(c => c.trackId === 'T1');
    if (!captionData || t1Clips.length === 0 || !onUpdateCaptionWords) {
      setChatHistory(prev => [...prev, {
        type: 'assistant',
        text: 'No captions found. Add captions first, then I can remove filler words.',
      }]);
      return;
    }

    let totalRemoved = 0;
    for (const clip of t1Clips) {
      const cd = captionData[clip.id];
      if (!cd?.words?.length) continue;
      const filtered = cd.words.filter(
        w => !FILLER_WORDS.has(w.text.toLowerCase().replace(/[.,!?'"]/g, ''))
      );
      const removed = cd.words.length - filtered.length;
      if (removed > 0) {
        onUpdateCaptionWords(clip.id, filtered);
        totalRemoved += removed;
      }
    }

    setChatHistory(prev => [...prev, {
      type: 'assistant',
      text: totalRemoved === 0
        ? 'Your captions look clean — no common filler words (um, uh, like, basically, etc.) found.'
        : `Removed ${totalRemoved} filler word${totalRemoved !== 1 ? 's' : ''} from your captions (um, uh, like, basically, literally, etc.).`,
    }]);
  };

  const handlePlatformPresetWorkflow = (platform: PlatformPreset) => {
    setChatHistory(prev => [...prev, {
      type: 'assistant',
      text: `Formatting for ${platform.label} — ${platform.width}×${platform.height} (${platform.aspectRatio}), ${platform.lufs} LUFS. Click Apply to process.`,
      command: platform.command,
      applied: false,
    }]);
    setShowPlatforms(false);
  };

  const handleAudioCleanWorkflow = () => {
    setChatHistory(prev => [...prev, {
      type: 'assistant',
      text: 'Removing background noise using FFT denoising + high-pass filter (cuts rumble below 80 Hz). Click Apply to process.',
      command: 'ffmpeg -i input.mp4 -af "highpass=f=80,afftdn=nf=-25" output.mp4',
      applied: false,
    }]);
  };

  const handleAudioNormalizeWorkflow = () => {
    setChatHistory(prev => [...prev, {
      type: 'assistant',
      text: 'Normalizing loudness to −16 LUFS (YouTube standard, EBU R128). Click Apply to process.',
      command: 'ffmpeg -i input.mp4 -af "loudnorm=I=-16:TP=-1.5:LRA=11" output.mp4',
      applied: false,
    }]);
  };

  const handleConfirmWorkflow = async (messageIndex: number, workflow: string) => {
    setChatHistory(prev => prev.map((msg, idx) =>
      idx === messageIndex ? { ...msg, confirmed: true } : msg
    ));
    switch (workflow) {
      case 'dead-air':    await handleDeadAirWorkflow(); break;
      case 'extract-audio': await handleExtractAudioWorkflow(); break;
    }
  };

  const handleDeclineWorkflow = (messageIndex: number) => {
    setChatHistory(prev => prev.map((msg, idx) =>
      idx === messageIndex ? { ...msg, declined: true } : msg
    ));
  };

  const handleApplyEdit = async (command: string, messageIndex: number) => {
    if (!onApplyEdit || !hasVideo || applyingIndex !== null) return;

    setApplyingIndex(messageIndex);
    try {
      await onApplyEdit(command);
      // Mark this message as applied
      setChatHistory((prev) =>
        prev.map((msg, idx) => (idx === messageIndex ? { ...msg, applied: true } : msg))
      );
    } catch (error) {
      console.error('Failed to apply edit:', error);
      setChatHistory((prev) => [
        ...prev,
        {
          type: 'assistant',
          text: `Failed to apply edit: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ]);
    } finally {
      setApplyingIndex(null);
    }
  };

  return (
    <div
      className={`h-full bg-zinc-900/80 border-l border-zinc-800/50 flex flex-col backdrop-blur-sm transition-colors relative ${
        isDragOverChat ? 'ring-2 ring-inset ring-purple-500/50 bg-purple-500/5' : ''
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drop overlay indicator */}
      {isDragOverChat && (
        <div className="absolute inset-0 flex items-center justify-center bg-purple-500/10 z-50 pointer-events-none">
          <div className="px-4 py-3 bg-purple-500/20 border border-purple-500/40 rounded-xl">
            <p className="text-sm text-purple-300 font-medium">Drop image to attach</p>
          </div>
        </div>
      )}
      {/* Header */}
      <div className="p-4 border-b border-zinc-800/50">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 h-8 bg-gradient-to-br from-orange-500 to-amber-500 rounded-lg flex items-center justify-center">
            <Sparkles className="w-4 h-4" />
          </div>
          <h2 className="font-semibold">HyperEdit AI</h2>
        </div>
        <p className="text-xs text-zinc-400">
          Describe what you want to do with your video
        </p>
      </div>


      {/* Edit animation mode indicator */}
      {activeTabId !== 'main' && editTabAssetId && (
        <div className="p-3 bg-blue-500/10 border-b border-blue-500/20">
          <div className="flex items-center gap-2">
            <Film className="w-4 h-4 text-blue-400" />
            <div className="flex-1">
              <p className="text-xs text-blue-300 font-medium">
                {editTabV1Context?.aiGenerated ? 'Remotion Animation Edit Mode' : 'Edit Mode'}
              </p>
              <p className="text-[10px] text-blue-400/70">
                {editTabV1Context?.aiGenerated
                  ? 'All edits will use Remotion. Use + to add assets from library.'
                  : 'Prompts will modify this clip. Use + to add assets from library.'}
              </p>
              {/* Show V1 context if detected */}
              {editTabV1Context && (
                <div className="mt-1.5 flex items-center gap-1.5">
                  <span className="text-[10px] text-blue-400/50">V1:</span>
                  <span className="px-1.5 py-0.5 bg-blue-500/20 rounded text-[10px] text-blue-300 truncate max-w-[150px]">
                    {editTabV1Context.filename}
                  </span>
                  {editTabV1Context.aiGenerated && (
                    <span className="px-1.5 py-0.5 bg-purple-500/20 rounded text-[10px] text-purple-300">
                      Remotion
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Processing overlay */}
      {isApplying && (
        <div className="p-4 bg-orange-500/10 border-b border-orange-500/20">
          <div className="flex items-center gap-3">
            <Loader2 className="w-5 h-5 text-orange-400 animate-spin" />
            <div className="flex-1">
              <p className="text-sm text-orange-200 font-medium">
                {applyStatus || 'Processing video...'}
              </p>
              {(applyProgress ?? 0) > 0 && (
                <>
                  <div className="mt-2 h-2 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-orange-500 to-amber-500 transition-all duration-300"
                      style={{ width: `${applyProgress}%` }}
                    />
                  </div>
                  <p className="text-xs text-zinc-400 mt-1">{applyProgress}% complete</p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Chat history */}
      <div className="flex-1 p-4 overflow-y-auto space-y-4">
        {chatHistory.length === 0 ? (
          <div className="text-center text-sm text-zinc-500 py-8">
            {hasVideo
              ? "No edits yet. Use Quick Actions below to get started!"
              : 'Upload a video first to start editing with AI'}
          </div>
        ) : (
          chatHistory.map((message, idx) => (
            <div key={idx} className="space-y-2">
              {message.type === 'user' ? (
                <div className="flex justify-end items-start gap-1.5 group/msg">
                  <button
                    type="button"
                    onClick={() => savePrompt(message.text)}
                    title={savedPrompts.includes(message.text.replace(/^\[[\d:]+\s*-\s*[\d:]+\]\s*/, '').replace(/^(@\S+\s*)+/, '').trim()) ? 'Already saved' : 'Save prompt'}
                    className="opacity-0 group-hover/msg:opacity-100 transition-opacity mt-1.5 p-1 rounded text-zinc-600 hover:text-amber-400"
                  >
                    <Star className="w-3 h-3" />
                  </button>
                  <div className="bg-gradient-to-r from-orange-500 to-amber-500 rounded-lg px-3 py-2 max-w-[85%]">
                    <p className="text-sm text-white">{message.text}</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="bg-zinc-800 rounded-lg p-3 space-y-2">
                    <p className="text-sm text-zinc-200 whitespace-pre-wrap">{message.text}</p>

                    {/* Clarifying question options */}
                    {pendingQuestion && idx === chatHistory.length - 1 && message.text === pendingQuestion.question && (
                      <div className="mt-3 grid grid-cols-1 gap-2">
                        {pendingQuestion.options.map((option) => (
                          <button
                            key={option.value}
                            onClick={() => handleClarificationChoice(pendingQuestion.id, option.value)}
                            className="flex items-start gap-3 p-3 bg-zinc-700/50 hover:bg-zinc-700 rounded-lg text-left transition-colors group"
                          >
                            <span className="text-lg">{option.icon}</span>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-white group-hover:text-orange-400 transition-colors">
                                {option.label}
                              </div>
                              <div className="text-xs text-zinc-400 mt-0.5">
                                {option.description}
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Animation concept approval buttons */}
                    {pendingAnimationConcept && idx === chatHistory.length - 1 && message.text.includes('Animation Concept Ready') && (
                      <div className="mt-4 flex gap-3">
                        <button
                          onClick={handleApproveAnimation}
                          disabled={isProcessing}
                          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800 disabled:cursor-not-allowed rounded-lg text-sm font-medium text-white transition-colors"
                        >
                          <CheckCircle className="w-4 h-4" />
                          Approve & Render
                        </button>
                        <button
                          onClick={handleCancelAnimation}
                          disabled={isProcessing}
                          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-zinc-700 hover:bg-zinc-600 disabled:bg-zinc-800 disabled:cursor-not-allowed rounded-lg text-sm font-medium text-zinc-300 transition-colors"
                        >
                          <X className="w-4 h-4" />
                          Cancel
                        </button>
                      </div>
                    )}

                    {/* Processing indicator */}
                    {message.isProcessingGifs && (
                      <div className="mt-2 flex items-center gap-2 text-xs text-orange-400">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        <span>Processing...</span>
                      </div>
                    )}

                    {/* Show extracted keywords */}
                    {message.extractedKeywords && message.extractedKeywords.length > 0 && (
                      <div className="mt-2 space-y-2">
                        <div className="text-[10px] text-zinc-500 font-medium">Found keywords:</div>
                        <div className="flex flex-wrap gap-1.5">
                          {message.extractedKeywords.map((kw, i) => (
                            <span
                              key={i}
                              className="px-2 py-1 bg-zinc-700/50 rounded text-[11px] text-zinc-300"
                              title={`At ${Math.floor(kw.timestamp / 60)}:${String(Math.floor(kw.timestamp % 60)).padStart(2, '0')}`}
                            >
                              {kw.keyword} @ {Math.floor(kw.timestamp / 60)}:{String(Math.floor(kw.timestamp % 60)).padStart(2, '0')}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Storyboard preview for batch animations */}
                    {message.pendingBatchAnimations && !message.batchAnimationsApplied && (
                      <div className="mt-3 space-y-3">
                        <div className="flex gap-2 flex-wrap">
                          {message.pendingBatchAnimations.map((anim, i) => (
                            <div key={i} className="w-24 rounded overflow-hidden border border-zinc-700 bg-zinc-800">
                              {anim.thumbnailUrl
                                ? <img src={anim.thumbnailUrl} className="w-full aspect-video object-cover" />
                                : <div className="w-full aspect-video bg-zinc-700 flex items-center justify-center text-xs text-zinc-500">No preview</div>
                              }
                              <div className="p-1 text-[10px] text-zinc-400 truncate" title={anim.title}>{anim.title}</div>
                            </div>
                          ))}
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleApplyStoryboardAnimations(idx)}
                            disabled={isProcessing}
                            className="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded-lg transition-colors"
                          >
                            ✅ Apply to Timeline
                          </button>
                          <button
                            onClick={() => handleCancelStoryboardAnimations(idx)}
                            disabled={isProcessing}
                            className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 text-white rounded-lg transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Audit results */}
                    {message.auditResults && message.auditResults.length > 0 && (
                      <div className="mt-3 space-y-1.5">
                        {message.auditResults.map((result, i) => (
                          <div
                            key={i}
                            className={`flex items-start gap-2 p-2 rounded-lg ${
                              result.severity === 'warning' ? 'bg-orange-500/10 border border-orange-500/20' :
                              result.severity === 'good'    ? 'bg-emerald-500/10 border border-emerald-500/20' :
                                                              'bg-zinc-700/40 border border-zinc-700/60'
                            }`}
                          >
                            <span className="text-sm shrink-0 mt-0.5">
                              {result.severity === 'warning' ? '⚠️' : result.severity === 'good' ? '✅' : 'ℹ️'}
                            </span>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-zinc-300 leading-relaxed">{result.message}</p>
                              {result.fixLabel && result.fixWorkflow && (
                                <button
                                  onClick={() => handleAuditFix(result.fixWorkflow!)}
                                  disabled={isProcessing}
                                  className="mt-1 text-[11px] text-orange-400 hover:text-orange-300 disabled:opacity-40 transition-colors font-medium"
                                >
                                  → {result.fixLabel}
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Confirm card for destructive workflows */}
                    {message.confirmWorkflow && !message.confirmed && !message.declined && (
                      <div className="mt-3 p-3 bg-zinc-800/80 border border-zinc-700/60 rounded-xl space-y-2">
                        <p className="text-xs font-semibold text-zinc-200">{message.confirmData?.description}</p>
                        <ul className="space-y-1">
                          {message.confirmData?.details.map((d, i) => (
                            <li key={i} className="text-[11px] text-zinc-400 leading-relaxed">· {d}</li>
                          ))}
                        </ul>
                        <div className="flex gap-2 pt-1">
                          <button
                            onClick={() => handleConfirmWorkflow(idx, message.confirmWorkflow!)}
                            disabled={isProcessing}
                            className="flex-1 py-1.5 rounded-lg bg-orange-500 hover:bg-orange-400 disabled:opacity-50 text-xs font-semibold text-white transition-colors"
                          >
                            Proceed
                          </button>
                          <button
                            onClick={() => handleDeclineWorkflow(idx)}
                            disabled={isProcessing}
                            className="px-4 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-xs font-medium text-zinc-300 transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                    {message.declined && message.confirmWorkflow && (
                      <p className="mt-2 text-[11px] text-zinc-600 italic">Cancelled.</p>
                    )}

                    {/* Scene detect result card */}
                    {message.sceneDetectResult && !message.sceneDetectResult.applied && (
                      <div className="mt-3 p-3 bg-zinc-800/80 border border-zinc-700/60 rounded-xl space-y-2">
                        <p className="text-xs font-semibold text-zinc-200">Scene changes detected</p>
                        <ul className="space-y-0.5 max-h-40 overflow-y-auto">
                          {message.sceneDetectResult.scenes.map((s, i) => {
                            const mins = Math.floor(s.timestamp / 60);
                            const secs = (s.timestamp % 60).toFixed(1);
                            return (
                              <li key={i} className="text-[11px] text-zinc-400 font-mono">
                                · {mins}:{secs.toString().padStart(4, '0')}
                              </li>
                            );
                          })}
                        </ul>
                        <button
                          onClick={async () => {
                            if (!onApplySceneCuts) return;
                            setIsProcessing(true);
                            try {
                              const timestamps = message.sceneDetectResult!.scenes.map(s => s.timestamp);
                              const result = await onApplySceneCuts(timestamps);
                              setChatHistory(prev => prev.map((m, i) =>
                                i === idx
                                  ? { ...m, sceneDetectResult: { ...m.sceneDetectResult!, applied: true },
                                      text: `✅ Applied ${result.cutsApplied} cut${result.cutsApplied !== 1 ? 's' : ''} at scene changes.` }
                                  : m
                              ));
                            } catch (err) {
                              console.error('Apply scene cuts failed:', err);
                            } finally {
                              setIsProcessing(false);
                            }
                          }}
                          disabled={isProcessing}
                          className="w-full py-1.5 rounded-lg bg-orange-500 hover:bg-orange-400 disabled:opacity-50 text-xs font-semibold text-white transition-colors"
                        >
                          Cut at {message.sceneDetectResult.scenes.length} scene{message.sceneDetectResult.scenes.length !== 1 ? 's' : ''}
                        </button>
                      </div>
                    )}
                    {message.sceneDetectResult?.applied && (
                      <div className="mt-2 flex items-center gap-2 px-3 py-2 bg-emerald-500/20 rounded-lg text-xs font-medium text-emerald-400">
                        <CheckCircle className="w-3 h-3" />
                        Scene cuts applied to timeline
                      </div>
                    )}

                    {/* Resequence result card */}
                    {message.resequenceResult && !message.resequenceResult.applied && (
                      <div className="mt-3 p-3 bg-zinc-800/80 border border-zinc-700/60 rounded-xl space-y-2">
                        <p className="text-xs font-semibold text-zinc-200">Proposed resequencing</p>
                        <ul className="space-y-1">
                          {message.resequenceResult.swaps.map((s, i) => (
                            <li key={i} className="text-[11px] text-zinc-400 leading-relaxed">
                              · Move <span className="text-zinc-200">"{s.from.label}"</span> ({s.from.startTime.toFixed(1)}s – {s.from.endTime.toFixed(1)}s) before <span className="text-zinc-200">"{s.to.label}"</span> ({s.to.startTime.toFixed(1)}s)
                            </li>
                          ))}
                        </ul>
                        <div className="flex gap-2 pt-1">
                          <button
                            onClick={async () => {
                              if (!onApplyResequence) return;
                              setIsProcessing(true);
                              try {
                                await onApplyResequence(message.resequenceResult!.swaps);
                                setChatHistory(prev => prev.map((m, i) =>
                                  i === idx
                                    ? { ...m, resequenceResult: { ...m.resequenceResult!, applied: true } }
                                    : m
                                ));
                              } catch (err) {
                                console.error('Apply resequence failed:', err);
                              } finally {
                                setIsProcessing(false);
                              }
                            }}
                            disabled={isProcessing}
                            className="flex-1 py-1.5 rounded-lg bg-orange-500 hover:bg-orange-400 disabled:opacity-50 text-xs font-semibold text-white transition-colors"
                          >
                            Apply resequence
                          </button>
                          <button
                            onClick={() => setChatHistory(prev => prev.map((m, i) =>
                              i === idx ? { ...m, resequenceResult: { ...m.resequenceResult!, applied: true } } : m
                            ))}
                            disabled={isProcessing}
                            className="px-4 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-xs font-medium text-zinc-300 transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                    {message.resequenceResult?.applied && (
                      <div className="mt-2 flex items-center gap-2 px-3 py-2 bg-emerald-500/20 rounded-lg text-xs font-medium text-emerald-400">
                        <CheckCircle className="w-3 h-3" />
                        Sections resequenced on timeline
                      </div>
                    )}

                    {/* Success indicator for GIF/Caption/B-roll/Dead air/Animation edit workflow */}
                    {message.applied && !message.command && !message.animationAssetId && (
                      <div className="mt-2 flex items-center gap-2 px-3 py-2 bg-emerald-500/20 rounded-lg text-xs font-medium text-emerald-400">
                        <CheckCircle className="w-3 h-3" />
                        {message.isCaptionWorkflow ? 'Captions added to timeline' :
                         message.isBrollWorkflow ? 'B-roll images added to V3 track' :
                         message.isDeadAirWorkflow ? 'Dead air removed from timeline' :
                         message.isInPlaceEdit ? 'Edit added to animation' :
                         'Applied to timeline'}
                      </div>
                    )}

                    {/* Undo button for reversible workflows */}
                    {message.applied && message.undoData && !message.undone && onUndoWorkflow && (
                      <button
                        onClick={() => handleUndo(idx)}
                        disabled={isProcessing}
                        className="mt-1 text-xs text-zinc-500 hover:text-red-400 disabled:opacity-40 transition-colors"
                      >
                        ↩ Undo
                      </button>
                    )}
                    {message.undone && (
                      <span className="mt-1 block text-xs text-zinc-600 italic">↩ Undone</span>
                    )}

                    {/* Animation created - offer to edit in new tab */}
                    {message.applied && message.animationAssetId && onOpenAnimationInTab && (
                      <div className="mt-3 space-y-2">
                        <div className="flex items-center gap-2 px-3 py-2 bg-emerald-500/20 rounded-lg text-xs font-medium text-emerald-400">
                          <CheckCircle className="w-3 h-3" />
                          Animation added to timeline
                        </div>
                        <button
                          onClick={() => onOpenAnimationInTab(message.animationAssetId!, message.animationName || 'Animation')}
                          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/30 rounded-lg text-xs font-medium text-blue-400 transition-colors"
                        >
                          <Film className="w-3.5 h-3.5" />
                          Edit in new timeline tab
                        </button>
                      </div>
                    )}

                    {/* FFmpeg command */}
                    {message.command && (
                      <div className="mt-2 space-y-2">
                        <div className="flex items-center gap-2 text-xs text-zinc-400">
                          <Terminal className="w-3 h-3" />
                          <span>FFmpeg Command</span>
                        </div>
                        <div className="bg-zinc-900 rounded p-2 font-mono text-xs text-orange-400 overflow-x-auto">
                          {message.command}
                        </div>
                        {message.applied ? (
                          <div className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-emerald-500/20 rounded-lg text-xs font-medium text-emerald-400">
                            <CheckCircle className="w-3 h-3" />
                            ✅ Edit Applied
                          </div>
                        ) : applyingIndex === idx ? (
                          <div className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-zinc-700 rounded-lg text-xs font-medium text-zinc-300">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Applying edit... (this may take a minute)
                          </div>
                        ) : (
                          <button
                            onClick={() => handleApplyEdit(message.command!, idx)}
                            disabled={isApplying || !hasVideo || applyingIndex !== null}
                            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 disabled:from-zinc-700 disabled:to-zinc-700 rounded-lg text-xs font-medium transition-all"
                          >
                            <CheckCircle className="w-3 h-3" />
                            Apply Edit
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))
        )}
        {isProcessing && (
          <div className="bg-zinc-800 rounded-lg p-3">
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <div className="w-4 h-4 border-2 border-orange-500/20 border-t-orange-500 rounded-full animate-spin" />
              <span>{processingStatus || 'Thinking...'}</span>
            </div>
          </div>
        )}
        {/* Scroll anchor */}
        <div ref={chatEndRef} />
      </div>

      {/* Timeline awareness bar — live project state */}
      {hasVideo && (
        <div className="flex items-center gap-2.5 px-3 py-1.5 border-t border-zinc-800/60 bg-zinc-900/40 shrink-0 flex-wrap">
          <span className="text-[11px] text-zinc-500 font-mono">{formatTimeShort(timelineSummary.videoDuration)}</span>
          {timelineSummary.hasCaptions && (
            <span className="text-[11px] text-blue-400/70">{timelineSummary.captionCount} captions</span>
          )}
          {timelineSummary.hasAnimations && (
            <span className="text-[11px] text-purple-400/70">{timelineSummary.animationCount} animations</span>
          )}
          {timelineSummary.hasGifs && (
            <span className="text-[11px] text-green-400/70">{timelineSummary.gifCount} GIFs</span>
          )}
          {timelineSummary.hasBroll && (
            <span className="text-[11px] text-amber-400/70">{timelineSummary.brollCount} B-roll</span>
          )}
          {timelineSummary.hasAudioTrack && (
            <span className="text-[11px] text-yellow-400/70">A1 audio</span>
          )}
          {timelineSummary.isEmptyTimeline && (
            <span className="text-[11px] text-zinc-600 italic">video only · no edits yet</span>
          )}
        </div>
      )}

      {/* Caption Options UI */}
      {showCaptionOptions && (
        <div className="p-4 border-t border-zinc-800/50 bg-zinc-800/50">
          <div className="space-y-3">
            <div className="text-xs font-medium text-zinc-300">Caption Style</div>

            {/* Font Selection */}
            <div className="flex items-center gap-2">
              <label className="text-xs text-zinc-400 w-20">Font:</label>
              <select
                value={captionOptions.fontFamily}
                onChange={(e) => setCaptionOptions(prev => ({ ...prev, fontFamily: e.target.value }))}
                className="flex-1 px-2 py-1.5 bg-zinc-700 border border-zinc-600 rounded text-xs text-white"
              >
                {FONT_OPTIONS.map(font => (
                  <option key={font} value={font}>{font}</option>
                ))}
              </select>
            </div>

            {/* Highlight Color */}
            <div className="flex items-center gap-2">
              <label className="text-xs text-zinc-400 w-20">Highlight:</label>
              <input
                type="color"
                value={captionOptions.highlightColor}
                onChange={(e) => setCaptionOptions(prev => ({ ...prev, highlightColor: e.target.value }))}
                className="w-8 h-8 rounded cursor-pointer bg-zinc-700 border border-zinc-600"
              />
              <span className="text-xs text-zinc-500">{captionOptions.highlightColor}</span>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setShowCaptionOptions(false)}
                className="flex-1 px-3 py-2 bg-zinc-700 hover:bg-zinc-600 rounded-lg text-xs font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCaptionWorkflow}
                disabled={isProcessing}
                className="flex-1 px-3 py-2 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 rounded-lg text-xs font-medium transition-all"
              >
                Add Captions
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Input */}
      <form onSubmit={handleSubmit} className="p-4 border-t border-zinc-800/50">
        {/* Motion Graphics Button */}
        <button
          type="button"
          onClick={() => setShowMotionGraphicsModal(true)}
          disabled={!hasVideo || isProcessing}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 mb-2 rounded-lg text-sm font-medium transition-all bg-gradient-to-r from-orange-500/20 to-amber-500/20 hover:from-orange-500/30 hover:to-amber-500/30 text-orange-300 hover:text-orange-200 border border-orange-500/30 hover:border-orange-500/50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Wand2 className="w-4 h-4" />
          Motion Graphics
        </button>

        {/* Quick Actions Popover */}
        <div className="relative mb-3" ref={quickActionsRef}>
          <button
            type="button"
            onClick={() => setShowQuickActions(!showQuickActions)}
            disabled={!hasVideo || isProcessing}
            className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
              showQuickActions
                ? 'bg-orange-500/20 text-orange-400 ring-1 ring-orange-500/50'
                : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-50 disabled:cursor-not-allowed'
            }`}
          >
            <Zap className="w-4 h-4" />
            Quick Actions
            {showQuickActions && <X className="w-3 h-3 ml-auto" />}
          </button>

          {/* Popover Menu */}
          {showQuickActions && (
            <div className="absolute bottom-full left-0 right-0 mb-2 p-2 bg-zinc-800 border border-zinc-700 rounded-xl shadow-xl z-10 animate-in fade-in slide-in-from-bottom-2 duration-200 max-h-80 overflow-y-auto">
              {savedPrompts.length > 0 && (
                <div className="mb-2">
                  <div className="flex items-center gap-1 px-1 mb-1">
                    <Star className="w-3 h-3 text-amber-400" />
                    <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wide">Saved</span>
                  </div>
                  <div className="space-y-1 mb-2">
                    {savedPrompts.map((p) => (
                      <div key={p} className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => { setPrompt(p); setShowQuickActions(false); }}
                          className="flex-1 text-left px-2.5 py-1.5 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 rounded-lg text-xs text-amber-200 transition-colors truncate"
                        >
                          {p}
                        </button>
                        <button
                          type="button"
                          onClick={() => removePrompt(p)}
                          className="p-1 text-zinc-600 hover:text-red-400 transition-colors shrink-0"
                          title="Remove"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-zinc-700/60 mb-2" />
                </div>
              )}
              <div className="grid grid-cols-2 gap-1.5">
                {suggestions.map((suggestion, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => {
                      setPrompt(suggestion.text);
                      setShowQuickActions(false);
                    }}
                    className="flex items-center gap-2 px-3 py-2.5 bg-zinc-700/50 hover:bg-zinc-700 rounded-lg text-xs text-left transition-colors group"
                  >
                    <suggestion.icon className="w-4 h-4 text-zinc-400 group-hover:text-orange-400 transition-colors flex-shrink-0" />
                    <span className="text-zinc-300 leading-tight">{suggestion.text}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Recipes Popover */}
        <div className="relative mb-3" ref={recipesRef}>
          <button
            type="button"
            onClick={() => { setShowRecipes(v => !v); setShowQuickActions(false); }}
            disabled={!hasVideo || isProcessing}
            className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
              showRecipes
                ? 'bg-orange-500/20 text-orange-400 ring-1 ring-orange-500/50'
                : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-50 disabled:cursor-not-allowed'
            }`}
          >
            <Zap className="w-4 h-4" />
            Recipes
            {showRecipes && <X className="w-3 h-3 ml-auto" />}
          </button>

          {showRecipes && (
            <div className="absolute bottom-full left-0 right-0 mb-2 bg-zinc-800 border border-zinc-700 rounded-xl shadow-xl z-10 animate-in fade-in slide-in-from-bottom-2 duration-200 p-3">
              <div className="text-xs font-semibold text-zinc-400 mb-2 px-1">⚡ Run a full editing pipeline</div>
              <div className="space-y-1.5 max-h-80 overflow-y-auto">
                {RECIPES.map(recipe => (
                  <button
                    key={recipe.id}
                    type="button"
                    onClick={() => executeRecipe(recipe)}
                    className="w-full text-left p-2.5 rounded-lg hover:bg-zinc-700 transition-colors group"
                  >
                    <div className="text-sm font-medium text-zinc-200 group-hover:text-orange-400 transition-colors">{recipe.label}</div>
                    <div className="text-xs text-zinc-500 mt-0.5">{recipe.description}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Platforms Popover */}
        <div className="relative mb-3" ref={platformsRef}>
          <button
            type="button"
            onClick={() => { setShowPlatforms(v => !v); setShowQuickActions(false); setShowRecipes(false); }}
            disabled={!hasVideo || isProcessing}
            className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
              showPlatforms
                ? 'bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/50'
                : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-50 disabled:cursor-not-allowed'
            }`}
          >
            <Globe className="w-4 h-4" />
            Platform Export
            {showPlatforms && <X className="w-3 h-3 ml-auto" />}
          </button>
          {showPlatforms && (
            <div className="absolute bottom-full left-0 right-0 mb-2 bg-zinc-800 border border-zinc-700 rounded-xl shadow-xl z-10 animate-in fade-in slide-in-from-bottom-2 duration-200 p-3">
              <div className="text-xs font-semibold text-zinc-400 mb-2 px-1">🌐 Re-encode for platform</div>
              <div className="space-y-1.5">
                {PLATFORM_PRESETS.map(preset => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => handlePlatformPresetWorkflow(preset)}
                    className="w-full text-left p-2.5 rounded-lg hover:bg-zinc-700 transition-colors group flex items-center gap-3"
                  >
                    <span className="text-base w-5 text-center shrink-0">{preset.emoji}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-zinc-200 group-hover:text-blue-400 transition-colors">{preset.label}</div>
                      <div className="text-xs text-zinc-500">{preset.width}×{preset.height} · {preset.aspectRatio} · {preset.lufs} LUFS</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Selected References, Time Range, and Attached Assets Tags */}
        {(selectedReferences.length > 0 || timeRange || attachedAssets.length > 0) && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {/* Time Range Tag */}
            {timeRange && (
              <div className="flex items-center gap-1 px-2 py-1 bg-blue-500/20 text-blue-300 rounded-md text-xs">
                <Timer className="w-3 h-3" />
                <span>{formatTimeShort(timeRange.start)} - {formatTimeShort(timeRange.end)}</span>
                <button
                  type="button"
                  onClick={clearTimeRange}
                  className="ml-0.5 hover:text-blue-100"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}
            {/* Reference Tags */}
            {selectedReferences.map((ref, idx) => (
              <div
                key={idx}
                className="flex items-center gap-1 px-2 py-1 bg-orange-500/20 text-orange-300 rounded-md text-xs"
              >
                {ref.type === 'clip' && <Film className="w-3 h-3" />}
                {ref.type === 'track' && <Type className="w-3 h-3" />}
                {ref.type === 'timestamp' && <MapPin className="w-3 h-3" />}
                <span className="truncate max-w-[100px]">{ref.label}</span>
                <button
                  type="button"
                  onClick={() => removeReference(idx)}
                  className="ml-0.5 hover:text-orange-100"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            {/* Attached Assets Tags */}
            {attachedAssets.map((asset, idx) => (
              <div
                key={asset.id}
                className="flex items-center gap-1 px-2 py-1 bg-purple-500/20 text-purple-300 rounded-md text-xs"
              >
                {asset.type === 'image' ? <Image className="w-3 h-3" /> : <Film className="w-3 h-3" />}
                <span className="truncate max-w-[100px]">{asset.filename}</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(idx)}
                  className="ml-0.5 hover:text-purple-100"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Unified Input Container */}
        <div className="bg-zinc-800 rounded-xl border border-zinc-700/50 focus-within:ring-2 focus-within:ring-orange-500/50 transition-all">
          {/* Textarea */}
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={hasVideo ? "Describe your edit..." : "Upload a video first..."}
            className="w-full px-3 pt-3 pb-2 bg-transparent text-sm resize-none focus:outline-none placeholder:text-zinc-500"
            rows={2}
            disabled={isProcessing || !hasVideo}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
          />

          {/* Bottom Toolbar */}
          <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex items-center gap-1">
              {/* Reference Picker Button */}
              <div className="relative" ref={referencePickerRef}>
                <button
                  type="button"
                  onClick={() => setShowReferencePicker(!showReferencePicker)}
                  disabled={!hasVideo || isProcessing}
                  className={`p-1.5 rounded-md transition-all ${
                    showReferencePicker
                      ? 'bg-orange-500/20 text-orange-400'
                      : 'hover:bg-zinc-700 text-zinc-400 hover:text-zinc-300 disabled:opacity-50'
                  }`}
                  title="Add asset from library"
                >
                  <Plus className="w-4 h-4" />
                </button>

                {/* Reference Picker Popover - Assets Only */}
                {showReferencePicker && (
                  <div className="absolute bottom-full left-0 mb-2 w-72 p-2 bg-zinc-800 border border-zinc-700 rounded-xl shadow-xl z-20 animate-in fade-in slide-in-from-bottom-2 duration-200">
                    <div className="text-xs font-medium text-zinc-400 px-2 py-1 mb-1">Select Asset</div>

                    {/* Assets list */}
                    <div className="max-h-64 overflow-y-auto space-y-1">
                      {assets.length === 0 ? (
                        <div className="px-2 py-4 text-center text-xs text-zinc-500">
                          No assets in library
                        </div>
                      ) : (
                        assets.map(asset => {
                          // Create a friendly display name
                          const displayName = asset.aiGenerated
                            ? asset.filename.replace(/^picasso-/, '').replace(/\.[^/.]+$/, '').replace(/-/g, ' ')
                            : asset.filename.replace(/\.[^/.]+$/, '');
                          const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}/.test(displayName);
                          const friendlyName = isUUID
                            ? `${asset.aiGenerated ? 'AI ' : ''}${asset.type.charAt(0).toUpperCase() + asset.type.slice(1)}`
                            : displayName.length > 25 ? displayName.substring(0, 25) + '...' : displayName;

                          return (
                            <button
                              key={asset.id}
                              type="button"
                              onClick={() => {
                                addReference({
                                  type: 'clip',
                                  id: asset.id,
                                  label: asset.filename,
                                  details: asset.type,
                                });
                                setShowReferencePicker(false);
                              }}
                              className="w-full flex items-center gap-3 px-2 py-2 hover:bg-zinc-700 rounded-lg text-left transition-colors group"
                            >
                              {/* Thumbnail or icon placeholder */}
                              <div className="w-12 h-12 rounded-lg overflow-hidden bg-zinc-700 flex-shrink-0 flex items-center justify-center">
                                {asset.thumbnailUrl ? (
                                  <img
                                    src={asset.thumbnailUrl}
                                    alt=""
                                    className="w-full h-full object-cover"
                                    onError={(e) => {
                                      e.currentTarget.style.display = 'none';
                                      e.currentTarget.nextElementSibling?.classList.remove('hidden');
                                    }}
                                  />
                                ) : null}
                                <div className={asset.thumbnailUrl ? 'hidden' : ''}>
                                  {asset.type === 'audio' ? (
                                    <Music className="w-5 h-5 text-emerald-400" />
                                  ) : asset.type === 'image' ? (
                                    <Image className="w-5 h-5 text-purple-400" />
                                  ) : (
                                    <Film className="w-5 h-5 text-blue-400" />
                                  )}
                                </div>
                              </div>

                              {/* Text info */}
                              <div className="flex-1 min-w-0">
                                <div className="text-sm text-zinc-200 truncate font-medium">{friendlyName}</div>
                                <div className="flex items-center gap-1.5 mt-0.5">
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                                    asset.type === 'video' ? 'bg-blue-500/20 text-blue-300' :
                                    asset.type === 'image' ? 'bg-purple-500/20 text-purple-300' :
                                    'bg-emerald-500/20 text-emerald-300'
                                  }`}>
                                    {asset.type}
                                  </span>
                                  {asset.aiGenerated && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-300">
                                      AI
                                    </span>
                                  )}
                                </div>
                              </div>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* File Attachment Button for Animations */}
              <div className="relative">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,video/*"
                  multiple
                  onChange={handleFileAttachment}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!hasVideo || isProcessing || isUploadingAttachment || !onUploadAttachment}
                  className={`p-1.5 rounded-md transition-all ${
                    attachedAssets.length > 0
                      ? 'bg-purple-500/20 text-purple-400'
                      : 'hover:bg-zinc-700 text-zinc-400 hover:text-zinc-300 disabled:opacity-50'
                  }`}
                  title={attachedAssets.length > 0 ? `${attachedAssets.length} file(s) attached` : 'Attach images/videos for animation'}
                >
                  {isUploadingAttachment ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <ImagePlus className="w-4 h-4" />
                  )}
                </button>
              </div>

              {/* Time Range Picker Button */}
              <div className="relative" ref={timeRangePickerRef}>
                <button
                  type="button"
                  onClick={() => {
                    if (!showTimeRangePicker) {
                      const videoAsset = assets.find(a => a.type === 'video');
                      const videoDuration = (videoAsset?.duration && videoAsset.duration > 0) ? videoAsset.duration : Infinity;
                      setTimeRangeInputs({
                        start: formatTimeShort(currentTime),
                        end: formatTimeShort(Math.min(currentTime + 30, videoDuration)),
                      });
                      setTimeRangeError(null);
                    }
                    setShowTimeRangePicker(!showTimeRangePicker);
                  }}
                  disabled={!hasVideo || isProcessing}
                  className={`p-1.5 rounded-md transition-all ${
                    showTimeRangePicker || timeRange
                      ? 'bg-blue-500/20 text-blue-400'
                      : 'hover:bg-zinc-700 text-zinc-400 hover:text-zinc-300 disabled:opacity-50'
                  }`}
                  title={timeRange ? `${formatTimeShort(timeRange.start)} - ${formatTimeShort(timeRange.end)}` : 'Set time range'}
                >
                  <Timer className="w-4 h-4" />
                </button>

                {/* Time Range Picker Popover */}
                {showTimeRangePicker && (
                  <div className="absolute bottom-full left-0 mb-2 w-56 p-3 bg-zinc-800 border border-zinc-700 rounded-xl shadow-xl z-20 animate-in fade-in slide-in-from-bottom-2 duration-200">
                    <div className="text-xs font-medium text-zinc-300 mb-3">Set Time Range</div>

                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-zinc-400 w-12">Start:</label>
                        <input
                          type="text"
                          value={timeRangeInputs.start}
                          onChange={(e) => setTimeRangeInputs(prev => ({ ...prev, start: e.target.value }))}
                          placeholder="0:00"
                          className="flex-1 px-2 py-1.5 bg-zinc-700 border border-zinc-600 rounded text-xs text-white placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-zinc-400 w-12">End:</label>
                        <input
                          type="text"
                          value={timeRangeInputs.end}
                          onChange={(e) => setTimeRangeInputs(prev => ({ ...prev, end: e.target.value }))}
                          placeholder="1:30"
                          className="flex-1 px-2 py-1.5 bg-zinc-700 border border-zinc-600 rounded text-xs text-white placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                        />
                      </div>
                    </div>

                    {timeRangeError ? (
                      <div className="text-[10px] text-red-400 mt-2 mb-3">{timeRangeError}</div>
                    ) : (
                      <div className="text-[10px] text-zinc-500 mt-2 mb-3">
                        Format: M:SS — e.g. 0:03, 0:33 (use colon, not dot)
                      </div>
                    )}

                    <div className="flex gap-2">
                      {timeRange && (
                        <button
                          type="button"
                          onClick={clearTimeRange}
                          className="flex-1 px-2 py-1.5 bg-zinc-700 hover:bg-zinc-600 rounded text-xs text-zinc-300 transition-colors"
                        >
                          Clear
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={applyTimeRange}
                        className="flex-1 px-2 py-1.5 bg-orange-500 hover:bg-orange-600 rounded text-xs text-white font-medium transition-colors"
                      >
                        Apply
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="w-px h-4 bg-zinc-700 mx-1" />

              <span className="text-[10px] text-zinc-500">Enter to send</span>
            </div>

            {/* Send Button */}
            <button
              type="submit"
              disabled={!prompt.trim() || isProcessing || !hasVideo}
              className="w-8 h-8 bg-gradient-to-r from-orange-500 to-amber-500 disabled:from-zinc-700 disabled:to-zinc-700 rounded-lg flex items-center justify-center transition-all hover:shadow-lg hover:shadow-orange-500/50 disabled:shadow-none"
            >
              {isProcessing ? (
                <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      </form>

      {/* Motion Graphics Modal */}
      {showMotionGraphicsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowMotionGraphicsModal(false)}
          />
          {/* Modal */}
          <div className="relative w-full max-w-lg max-h-[80vh] bg-zinc-900 rounded-xl border border-zinc-700 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            {/* Close button */}
            <button
              onClick={() => setShowMotionGraphicsModal(false)}
              className="absolute top-3 right-3 z-10 p-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
            <div className="h-[70vh] overflow-y-auto">
              <MotionGraphicsPanel
                onAddToTimeline={(templateId, props, duration) => {
                  if (onAddMotionGraphic) {
                    onAddMotionGraphic({ templateId, props, duration, startTime: currentTime });
                    setShowMotionGraphicsModal(false);
                  }
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
