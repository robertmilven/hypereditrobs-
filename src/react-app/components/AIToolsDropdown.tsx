import { useState, useRef, useEffect } from 'react';
import {
  Sparkles,
  Layers,
  Image,
  Camera,
  Zap,
  Scissors,
  Code,
  HelpCircle,
  ChevronDown,
  Film,
  Search,
  Layout,
} from 'lucide-react';

type ToolId = 'scene' | 'broll' | 'thumbnail' | 'viral' | 'repurpose' | 'remotion' | 'shortcuts' | 'stockfootage' | 'reaction' | 'templates';

interface AIToolsDropdownProps {
  onSelect: (toolId: ToolId) => void;
  activePanel?: ToolId | null;
}

const AI_TOOLS: Array<{
  id: ToolId;
  icon: typeof Sparkles;
  label: string;
  description: string;
  color: string;
  group: 'analyze' | 'create' | 'help';
}> = [
  // Analyze Group
  { id: 'scene', icon: Layers, label: 'Scene Detection', description: 'Detect scene boundaries', color: 'text-blue-400', group: 'analyze' },
  { id: 'broll', icon: Image, label: 'B-Roll Suggestions', description: 'AI-powered b-roll', color: 'text-green-400', group: 'analyze' },
  { id: 'thumbnail', icon: Camera, label: 'Thumbnail Generator', description: 'Create thumbnails', color: 'text-orange-400', group: 'analyze' },
  { id: 'viral', icon: Zap, label: 'Make it Viral', description: 'Viral edit presets', color: 'text-pink-400', group: 'analyze' },
  { id: 'repurpose', icon: Scissors, label: 'Content Repurpose', description: 'Long to shorts', color: 'text-purple-400', group: 'analyze' },
  // Create Group
  { id: 'remotion', icon: Code, label: 'Remotion Generator', description: 'Custom animations', color: 'text-cyan-400', group: 'create' },
  { id: 'stockfootage', icon: Search, label: 'Stock Footage', description: 'Search Pexels & Pixabay', color: 'text-emerald-400', group: 'create' },
  { id: 'reaction', icon: Layout, label: 'Reaction Video', description: 'PiP, side-by-side, split', color: 'text-rose-400', group: 'create' },
  { id: 'templates', icon: Film, label: 'Video Templates', description: '8 Remotion templates', color: 'text-amber-400', group: 'create' },
  // Help Group
  { id: 'shortcuts', icon: HelpCircle, label: 'Keyboard Shortcuts', description: 'View all shortcuts', color: 'text-zinc-400', group: 'help' },
];

export default function AIToolsDropdown({ onSelect, activePanel }: AIToolsDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // Close on ESC
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen]);

  const handleSelect = (toolId: ToolId) => {
    onSelect(toolId);
    setIsOpen(false);
  };

  const analyzeTools = AI_TOOLS.filter(t => t.group === 'analyze');
  const createTools = AI_TOOLS.filter(t => t.group === 'create');
  const helpTools = AI_TOOLS.filter(t => t.group === 'help');

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Trigger Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
          isOpen || activePanel
            ? 'bg-gradient-to-r from-purple-500 to-pink-500 text-white'
            : 'bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300'
        }`}
      >
        <Sparkles className="w-4 h-4" />
        AI Tools
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-72 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden z-[9999]">
          {/* Header */}
          <div className="px-4 py-2 border-b border-zinc-800 bg-gradient-to-r from-purple-500/10 to-pink-500/10">
            <span className="text-xs font-medium text-zinc-400">AI-Powered Tools</span>
          </div>

          {/* Analyze Section */}
          <div className="p-2">
            <div className="px-2 py-1 text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
              Analyze & Edit
            </div>
            {analyzeTools.map((tool) => {
              const Icon = tool.icon;
              const isActive = activePanel === tool.id;
              return (
                <button
                  key={tool.id}
                  onClick={() => handleSelect(tool.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${
                    isActive
                      ? 'bg-purple-500/20 text-white'
                      : 'hover:bg-zinc-800 text-zinc-300'
                  }`}
                >
                  <Icon className={`w-4 h-4 ${tool.color}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{tool.label}</div>
                    <div className="text-[10px] text-zinc-500 truncate">{tool.description}</div>
                  </div>
                  {isActive && (
                    <div className="w-2 h-2 rounded-full bg-purple-500" />
                  )}
                </button>
              );
            })}
          </div>

          {/* Create Section */}
          <div className="p-2 border-t border-zinc-800">
            <div className="px-2 py-1 text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
              Create
            </div>
            {createTools.map((tool) => {
              const Icon = tool.icon;
              const isActive = activePanel === tool.id;
              return (
                <button
                  key={tool.id}
                  onClick={() => handleSelect(tool.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${
                    isActive
                      ? 'bg-purple-500/20 text-white'
                      : 'hover:bg-zinc-800 text-zinc-300'
                  }`}
                >
                  <Icon className={`w-4 h-4 ${tool.color}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{tool.label}</div>
                    <div className="text-[10px] text-zinc-500 truncate">{tool.description}</div>
                  </div>
                  {isActive && (
                    <div className="w-2 h-2 rounded-full bg-purple-500" />
                  )}
                </button>
              );
            })}
          </div>

          {/* Help Section */}
          <div className="p-2 border-t border-zinc-800">
            {helpTools.map((tool) => {
              const Icon = tool.icon;
              return (
                <button
                  key={tool.id}
                  onClick={() => handleSelect(tool.id)}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors hover:bg-zinc-800 text-zinc-400"
                >
                  <Icon className={`w-4 h-4 ${tool.color}`} />
                  <div className="text-sm">{tool.label}</div>
                  <span className="ml-auto text-[10px] text-zinc-600">?</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
