import { useMemo } from 'react';
import type { CaptionWord, CaptionStyle } from '@/react-app/hooks/useProject';

interface CaptionRendererProps {
  words: CaptionWord[];
  style: CaptionStyle;
  currentTime: number;  // Time within the caption clip
}

// Group words into chunks of 2-4 for better readability (FrameForge style)
function groupWords(words: CaptionWord[], maxPerGroup: number = 4): CaptionWord[][] {
  if (words.length === 0) return [];
  const groups: CaptionWord[][] = [];
  let current: CaptionWord[] = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    current.push(word);

    const isLast = i === words.length - 1;
    const next = isLast ? null : words[i + 1];
    let shouldBreak = false;

    if (current.length >= maxPerGroup) shouldBreak = true;
    if (next && next.start - word.end > 0.3) shouldBreak = true;
    if (/[.,!?;:]$/.test(word.text)) shouldBreak = true;
    if (isLast) shouldBreak = true;

    if (shouldBreak && current.length > 0) {
      groups.push([...current]);
      current = [];
    }
  }
  return groups;
}

export default function CaptionRenderer({ words, style, currentTime }: CaptionRendererProps) {
  const adjustedTime = currentTime - (style.timeOffset || 0);

  // Use word grouping for FrameForge-style animations
  const useGrouping = ['highlight', 'bold-center', 'minimal'].includes(style.animation);

  const wordGroups = useMemo(() => groupWords(words, 4), [words]);

  // Find active group for grouped modes
  const activeGroup = useMemo(() => {
    if (!useGrouping) return null;
    for (const group of wordGroups) {
      const groupStart = group[0].start;
      const groupEnd = group[group.length - 1].end;
      if (adjustedTime >= groupStart && adjustedTime <= groupEnd + 0.15) {
        return group;
      }
    }
    return null;
  }, [wordGroups, adjustedTime, useGrouping]);

  // Find visible words and active word for non-grouped modes
  const { visibleWords, activeWordIndex } = useMemo(() => {
    const visible: { word: CaptionWord; index: number }[] = [];
    let activeIndex = -1;

    words.forEach((word, index) => {
      if (style.animation === 'typewriter') {
        if (adjustedTime >= word.start) {
          visible.push({ word, index });
        }
      } else {
        visible.push({ word, index });
      }

      if (adjustedTime >= word.start && adjustedTime < word.end) {
        activeIndex = index;
      }
    });

    return { visibleWords: visible, activeWordIndex: activeIndex };
  }, [words, adjustedTime, style.animation]);

  // Position styles
  const positionStyles = useMemo((): React.CSSProperties => {
    const base: React.CSSProperties = {
      position: 'absolute',
      left: '50%',
      transform: 'translateX(-50%)',
      textAlign: 'center',
      width: '90%',
      maxWidth: '90%',
    };

    switch (style.position) {
      case 'top':
        return { ...base, top: '8%' };
      case 'center':
        return { ...base, top: '50%', transform: 'translate(-50%, -50%)' };
      case 'bottom':
      default:
        return { ...base, bottom: '8%' };
    }
  }, [style.position]);

  // Base text styles
  const textStyles = useMemo((): React.CSSProperties => {
    return {
      fontFamily: style.fontFamily,
      fontSize: `${style.fontSize}px`,
      fontWeight: style.fontWeight === 'black' ? 900 : style.fontWeight === 'bold' ? 700 : 400,
      color: style.color,
      textShadow: style.strokeWidth
        ? `
          -${style.strokeWidth}px -${style.strokeWidth}px 0 ${style.strokeColor},
          ${style.strokeWidth}px -${style.strokeWidth}px 0 ${style.strokeColor},
          -${style.strokeWidth}px ${style.strokeWidth}px 0 ${style.strokeColor},
          ${style.strokeWidth}px ${style.strokeWidth}px 0 ${style.strokeColor}
        `
        : undefined,
      backgroundColor: style.backgroundColor,
      padding: style.backgroundColor ? '4px 12px' : undefined,
      borderRadius: style.backgroundColor ? '4px' : undefined,
      lineHeight: 1.4,
    };
  }, [style]);

  // Word animation styles
  const getWordStyle = (wordIndex: number, word: CaptionWord): React.CSSProperties => {
    const isActive = wordIndex === activeWordIndex;
    const hasStarted = adjustedTime >= word.start;
    const progress = Math.min(1, Math.max(0, (adjustedTime - word.start) / (word.end - word.start)));

    switch (style.animation) {
      case 'karaoke':
        return {
          color: isActive ? style.highlightColor || '#FFD700' : hasStarted && adjustedTime > word.end ? style.highlightColor || '#FFD700' : style.color,
          opacity: hasStarted ? 1 : 0.35,
          transition: 'color 0.1s ease, opacity 0.1s ease',
        };

      case 'fade':
        return {
          opacity: hasStarted ? 1 : 0.3,
          transition: 'opacity 0.3s ease',
        };

      case 'pop':
        return {
          transform: isActive ? 'scale(1.25)' : 'scale(1)',
          display: 'inline-block',
          transition: 'transform 0.12s cubic-bezier(0.34, 1.56, 0.64, 1)',
          filter: isActive ? `drop-shadow(0 0 8px ${style.highlightColor || '#FFD700'})` : 'none',
        };

      case 'bounce':
        return {
          transform: isActive ? 'translateY(-6px) scale(1.1)' : 'translateY(0) scale(1)',
          display: 'inline-block',
          transition: 'transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1)',
          color: isActive ? style.highlightColor || '#FFD700' : style.color,
        };

      case 'typewriter':
      case 'none':
      default:
        return {};
    }
  };

  // FrameForge grouped animation styles
  const getGroupedWordStyle = (word: CaptionWord, indexInGroup: number): React.CSSProperties => {
    const isActive = adjustedTime >= word.start && adjustedTime < word.end;
    const hasStarted = adjustedTime >= word.start;

    switch (style.animation) {
      case 'highlight':
        return {
          display: 'inline-block',
          padding: '2px 6px',
          margin: '0 2px',
          borderRadius: '4px',
          backgroundColor: isActive ? (style.highlightColor || '#FFD700') : 'transparent',
          color: isActive ? '#000000' : style.color,
          transform: isActive ? 'scale(1.12)' : 'scale(1)',
          boxShadow: isActive ? `0 4px 12px ${style.highlightColor || '#FFD700'}40` : 'none',
          transition: 'all 0.12s cubic-bezier(0.34, 1.56, 0.64, 1)',
        };

      case 'bold-center':
        return {
          display: 'inline-block',
          fontSize: `${(style.fontSize || 24) * 1.3}px`,
          fontWeight: 900,
          textTransform: 'uppercase' as const,
          letterSpacing: '2px',
          transform: isActive ? 'scale(1.5) rotate(-2deg)' : hasStarted ? 'scale(1.1)' : 'scale(0.8)',
          opacity: hasStarted ? 1 : 0,
          color: isActive ? (style.highlightColor || '#FFD700') : style.color,
          transition: 'all 0.15s cubic-bezier(0.34, 1.56, 0.64, 1)',
          margin: '0 6px',
        };

      case 'minimal':
        return {
          display: 'inline-block',
          opacity: hasStarted ? 1 : 0,
          transform: hasStarted ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.25s ease-out',
          margin: '0 4px',
        };

      default:
        return {};
    }
  };

  // Render grouped mode (FrameForge style - only show active word group)
  if (useGrouping && activeGroup) {
    return (
      <div style={positionStyles} className="pointer-events-none z-40">
        <div style={{
          ...textStyles,
          backgroundColor: style.animation === 'highlight' ? 'rgba(0,0,0,0.85)' : textStyles.backgroundColor,
          padding: '12px 24px',
          borderRadius: '12px',
          backdropFilter: 'blur(8px)',
        }}>
          {activeGroup.map((word, i) => (
            <span
              key={`${word.start}-${word.text}`}
              style={getGroupedWordStyle(word, i)}
            >
              {word.text}
              {i < activeGroup.length - 1 ? ' ' : ''}
            </span>
          ))}
        </div>
      </div>
    );
  }

  // Render non-grouped mode (original + enhanced)
  if (visibleWords.length === 0) {
    return null;
  }

  return (
    <div style={positionStyles} className="pointer-events-none z-40">
      <div style={textStyles}>
        {visibleWords.map(({ word, index }, i) => (
          <span
            key={`${index}-${word.text}`}
            style={getWordStyle(index, word)}
          >
            {word.text}
            {i < visibleWords.length - 1 ? ' ' : ''}
          </span>
        ))}
      </div>
    </div>
  );
}
