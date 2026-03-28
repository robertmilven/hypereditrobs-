import { useCallback, useState, useEffect } from 'react';
import { Type, X, Palette, AlignCenter, Edit3, Check } from 'lucide-react';
import type { CaptionStyle, CaptionData, CaptionWord } from '@/react-app/hooks/useProject';

interface CaptionPropertiesPanelProps {
  captionData: CaptionData;
  onUpdateStyle: (styleUpdates: Partial<CaptionStyle>) => void;
  onUpdateText?: (newWords: CaptionWord[]) => void;
  onClose: () => void;
}

const FONT_OPTIONS = [
  { value: 'Inter', label: 'Inter' },
  { value: 'Roboto', label: 'Roboto' },
  { value: 'Poppins', label: 'Poppins' },
  { value: 'Montserrat', label: 'Montserrat' },
  { value: 'Oswald', label: 'Oswald' },
  { value: 'Bebas Neue', label: 'Bebas Neue' },
  { value: 'Arial', label: 'Arial' },
  { value: 'Helvetica', label: 'Helvetica' },
];

const ANIMATION_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'karaoke', label: 'Karaoke' },
  { value: 'fade', label: 'Fade In' },
  { value: 'pop', label: 'Pop' },
  { value: 'bounce', label: 'Bounce' },
  { value: 'highlight', label: 'Highlight Box' },
  { value: 'bold-center', label: 'Bold Center' },
  { value: 'minimal', label: 'Minimal' },
];

const POSITION_OPTIONS = [
  { value: 'top', label: 'Top' },
  { value: 'center', label: 'Center' },
  { value: 'bottom', label: 'Bottom' },
];

export default function CaptionPropertiesPanel({
  captionData,
  onUpdateStyle,
  onUpdateText,
  onClose,
}: CaptionPropertiesPanelProps) {
  const style = captionData.style;
  const [isEditingText, setIsEditingText] = useState(false);
  const [editedText, setEditedText] = useState('');

  // Initialize edited text when caption data changes
  useEffect(() => {
    setEditedText(captionData.words.map(w => w.text).join(' '));
  }, [captionData.words]);

  const handleSaveText = useCallback(() => {
    if (!onUpdateText) return;

    // Parse the edited text back into words while preserving timing
    const newWords = editedText.split(/\s+/).filter(Boolean);
    const oldWords = captionData.words;

    // Create new word objects, preserving timing from original words where possible
    const updatedWords: CaptionWord[] = newWords.map((text, index) => {
      if (index < oldWords.length) {
        // Preserve timing from original word
        return { ...oldWords[index], text };
      } else {
        // New word added - estimate timing based on last word
        const lastWord = oldWords[oldWords.length - 1];
        const avgDuration = lastWord ? (lastWord.end - lastWord.start) : 0.3;
        const start = lastWord ? lastWord.end + 0.1 : 0;
        return { text, start, end: start + avgDuration };
      }
    });

    onUpdateText(updatedWords);
    setIsEditingText(false);
  }, [editedText, captionData.words, onUpdateText]);

  const handleFontChange = useCallback((value: string) => {
    onUpdateStyle({ fontFamily: value });
  }, [onUpdateStyle]);

  const handleFontSizeChange = useCallback((value: number) => {
    onUpdateStyle({ fontSize: value });
  }, [onUpdateStyle]);

  const handleFontWeightChange = useCallback((value: 'normal' | 'bold' | 'black') => {
    onUpdateStyle({ fontWeight: value });
  }, [onUpdateStyle]);

  const handleColorChange = useCallback((value: string) => {
    onUpdateStyle({ color: value });
  }, [onUpdateStyle]);

  const handleStrokeColorChange = useCallback((value: string) => {
    onUpdateStyle({ strokeColor: value });
  }, [onUpdateStyle]);

  const handleStrokeWidthChange = useCallback((value: number) => {
    onUpdateStyle({ strokeWidth: value });
  }, [onUpdateStyle]);

  const handlePositionChange = useCallback((value: 'top' | 'center' | 'bottom') => {
    onUpdateStyle({ position: value });
  }, [onUpdateStyle]);

  const handleAnimationChange = useCallback((value: CaptionStyle['animation']) => {
    onUpdateStyle({ animation: value });
  }, [onUpdateStyle]);

  const handleHighlightColorChange = useCallback((value: string) => {
    onUpdateStyle({ highlightColor: value });
  }, [onUpdateStyle]);

  // Get caption text preview
  const textPreview = captionData.words.slice(0, 3).map(w => w.text).join(' ') +
    (captionData.words.length > 3 ? '...' : '');

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/50">
        <span className="text-xs font-medium text-zinc-400">Caption Properties</span>
        <button
          onClick={onClose}
          className="p-1 hover:bg-zinc-700 rounded transition-colors"
          title="Deselect caption"
        >
          <X className="w-3.5 h-3.5 text-zinc-500" />
        </button>
      </div>

      {/* Caption Text - Editable */}
      <div className="px-3 py-2 border-b border-zinc-800/50">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-2 text-xs text-white font-medium">
            <Type className="w-3.5 h-3.5 text-purple-400" />
            <span>Caption Text</span>
          </div>
          {onUpdateText && (
            isEditingText ? (
              <button
                onClick={handleSaveText}
                className="flex items-center gap-1 px-2 py-0.5 bg-green-600 hover:bg-green-500 rounded text-[10px] text-white transition-colors"
                title="Save changes"
              >
                <Check className="w-3 h-3" />
                Save
              </button>
            ) : (
              <button
                onClick={() => setIsEditingText(true)}
                className="flex items-center gap-1 px-2 py-0.5 bg-zinc-700 hover:bg-zinc-600 rounded text-[10px] text-zinc-300 transition-colors"
                title="Edit caption text"
              >
                <Edit3 className="w-3 h-3" />
                Edit
              </button>
            )
          )}
        </div>
        {isEditingText ? (
          <textarea
            value={editedText}
            onChange={(e) => setEditedText(e.target.value)}
            className="w-full px-2 py-1.5 bg-zinc-800 border border-purple-500 rounded text-xs text-white resize-none focus:outline-none focus:ring-1 focus:ring-purple-500"
            rows={3}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSaveText();
              }
              if (e.key === 'Escape') {
                setIsEditingText(false);
                setEditedText(captionData.words.map(w => w.text).join(' '));
              }
            }}
          />
        ) : (
          <div
            className="px-2 py-1.5 bg-zinc-800/50 rounded text-xs text-zinc-300 cursor-pointer hover:bg-zinc-800 transition-colors"
            onClick={() => onUpdateText && setIsEditingText(true)}
            title={onUpdateText ? "Click to edit" : undefined}
          >
            {textPreview || 'Caption'}
          </div>
        )}
        <div className="text-[10px] text-zinc-500 mt-1">
          {captionData.words.length} words
        </div>
      </div>

      {/* Properties */}
      <div className="flex-1 overflow-auto p-3 space-y-4">
        {/* Font Family */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Type className="w-3.5 h-3.5 text-zinc-500" />
            <span className="text-xs font-medium text-zinc-300">Font</span>
          </div>
          <select
            value={style.fontFamily}
            onChange={(e) => handleFontChange(e.target.value)}
            className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-white"
          >
            {FONT_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Font Size */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-zinc-300">Size</span>
            <span className="text-xs text-zinc-400">{style.fontSize}px</span>
          </div>
          <input
            type="range"
            min="24"
            max="96"
            step="2"
            value={style.fontSize}
            onChange={(e) => handleFontSizeChange(parseInt(e.target.value))}
            className="w-full h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
          />
        </div>

        {/* Font Weight */}
        <div>
          <span className="text-xs font-medium text-zinc-300 block mb-2">Weight</span>
          <div className="flex gap-1">
            {(['normal', 'bold', 'black'] as const).map(weight => (
              <button
                key={weight}
                onClick={() => handleFontWeightChange(weight)}
                className={`flex-1 px-2 py-1 text-xs rounded transition-colors ${
                  style.fontWeight === weight
                    ? 'bg-purple-500 text-white'
                    : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
                }`}
              >
                {weight.charAt(0).toUpperCase() + weight.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Colors */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Palette className="w-3.5 h-3.5 text-zinc-500" />
            <span className="text-xs font-medium text-zinc-300">Colors</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-zinc-500 mb-1 block">Text</label>
              <input
                type="color"
                value={style.color}
                onChange={(e) => handleColorChange(e.target.value)}
                className="w-full h-8 rounded cursor-pointer bg-zinc-800 border border-zinc-700"
              />
            </div>
            <div>
              <label className="text-[10px] text-zinc-500 mb-1 block">Stroke</label>
              <input
                type="color"
                value={style.strokeColor || '#000000'}
                onChange={(e) => handleStrokeColorChange(e.target.value)}
                className="w-full h-8 rounded cursor-pointer bg-zinc-800 border border-zinc-700"
              />
            </div>
          </div>
        </div>

        {/* Stroke Width */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-zinc-300">Stroke Width</span>
            <span className="text-xs text-zinc-400">{style.strokeWidth || 0}px</span>
          </div>
          <input
            type="range"
            min="0"
            max="6"
            step="1"
            value={style.strokeWidth || 0}
            onChange={(e) => handleStrokeWidthChange(parseInt(e.target.value))}
            className="w-full h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
          />
        </div>

        {/* Position */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <AlignCenter className="w-3.5 h-3.5 text-zinc-500" />
            <span className="text-xs font-medium text-zinc-300">Position</span>
          </div>
          <div className="flex gap-1">
            {POSITION_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => handlePositionChange(opt.value as 'top' | 'center' | 'bottom')}
                className={`flex-1 px-2 py-1 text-xs rounded transition-colors ${
                  style.position === opt.value
                    ? 'bg-purple-500 text-white'
                    : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Animation */}
        <div>
          <span className="text-xs font-medium text-zinc-300 block mb-2">Animation</span>
          <select
            value={style.animation}
            onChange={(e) => handleAnimationChange(e.target.value as CaptionStyle['animation'])}
            className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-white"
          >
            {ANIMATION_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Highlight Color (for karaoke, highlight, bold-center, pop, bounce) */}
        {['karaoke', 'highlight', 'bold-center', 'pop', 'bounce'].includes(style.animation) && (
          <div>
            <label className="text-xs font-medium text-zinc-300 block mb-2">Highlight Color</label>
            <input
              type="color"
              value={style.highlightColor || '#FFD700'}
              onChange={(e) => handleHighlightColorChange(e.target.value)}
              className="w-full h-8 rounded cursor-pointer bg-zinc-800 border border-zinc-700"
            />
          </div>
        )}

        {/* Time Offset */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-zinc-300">Time Offset</span>
            <span className="text-xs text-zinc-400">{(style.timeOffset || 0).toFixed(1)}s</span>
          </div>
          <input
            type="range"
            min="-5"
            max="5"
            step="0.1"
            value={style.timeOffset || 0}
            onChange={(e) => onUpdateStyle({ timeOffset: parseFloat(e.target.value) })}
            className="w-full h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
          />
          <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
            <span>Earlier</span>
            <span>Later</span>
          </div>
        </div>
      </div>
    </div>
  );
}
