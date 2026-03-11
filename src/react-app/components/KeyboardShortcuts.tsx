import { X, Keyboard } from 'lucide-react';

interface KeyboardShortcutsProps {
  isOpen: boolean;
  onClose: () => void;
}

const SHORTCUTS = [
  { category: 'Timeline', shortcuts: [
    { keys: ['Delete', 'Backspace'], action: 'Delete selected clip' },
    { keys: ['Ctrl', 'Z'], action: 'Undo (coming soon)' },
    { keys: ['Scroll'], action: 'Zoom timeline' },
  ]},
  { category: 'Playback', shortcuts: [
    { keys: ['Space'], action: 'Play / Pause' },
    { keys: ['←', '→'], action: 'Seek backward / forward' },
  ]},
  { category: 'AI Panel', shortcuts: [
    { keys: ['Enter'], action: 'Send prompt' },
    { keys: ['Shift', 'Enter'], action: 'New line in prompt' },
  ]},
  { category: 'General', shortcuts: [
    { keys: ['?'], action: 'Show this help' },
    { keys: ['Esc'], action: 'Close modals / Deselect' },
  ]},
];

export default function KeyboardShortcuts({ isOpen, onClose }: KeyboardShortcutsProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Keyboard className="w-5 h-5 text-orange-500" />
            <h2 className="text-sm font-semibold text-white">Keyboard Shortcuts</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-zinc-800 rounded transition-colors"
          >
            <X className="w-4 h-4 text-zinc-400" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 max-h-[60vh] overflow-y-auto space-y-4">
          {SHORTCUTS.map((category) => (
            <div key={category.category}>
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
                {category.category}
              </h3>
              <div className="space-y-2">
                {category.shortcuts.map((shortcut, idx) => (
                  <div key={idx} className="flex items-center justify-between py-1.5">
                    <span className="text-sm text-zinc-300">{shortcut.action}</span>
                    <div className="flex items-center gap-1">
                      {shortcut.keys.map((key, keyIdx) => (
                        <span key={keyIdx}>
                          <kbd className="px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs font-mono text-zinc-300">
                            {key}
                          </kbd>
                          {keyIdx < shortcut.keys.length - 1 && (
                            <span className="text-zinc-600 mx-0.5">+</span>
                          )}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-zinc-800 bg-zinc-800/30">
          <p className="text-[11px] text-zinc-500 text-center">
            Press <kbd className="px-1.5 py-0.5 bg-zinc-700 rounded text-[10px] font-mono">?</kbd> anytime to show this guide
          </p>
        </div>
      </div>
    </div>
  );
}
