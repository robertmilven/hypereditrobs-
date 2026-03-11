import { useState } from 'react';
import { Layout, Youtube, Instagram, Twitter, Video, ChevronDown, Check } from 'lucide-react';

interface ProjectTemplate {
  id: string;
  name: string;
  icon: typeof Youtube;
  aspectRatio: '16:9' | '9:16' | '1:1';
  description: string;
  suggestedDuration?: string;
  color: string;
}

const TEMPLATES: ProjectTemplate[] = [
  {
    id: 'youtube',
    name: 'YouTube',
    icon: Youtube,
    aspectRatio: '16:9',
    description: 'Landscape video for YouTube',
    suggestedDuration: '8-15 min',
    color: 'text-red-500',
  },
  {
    id: 'youtube-shorts',
    name: 'YouTube Shorts',
    icon: Youtube,
    aspectRatio: '9:16',
    description: 'Vertical short-form video',
    suggestedDuration: '15-60 sec',
    color: 'text-red-500',
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    icon: Video,
    aspectRatio: '9:16',
    description: 'Vertical video for TikTok',
    suggestedDuration: '15-60 sec',
    color: 'text-pink-500',
  },
  {
    id: 'instagram-reel',
    name: 'Instagram Reel',
    icon: Instagram,
    aspectRatio: '9:16',
    description: 'Vertical Reel for Instagram',
    suggestedDuration: '15-90 sec',
    color: 'text-purple-500',
  },
  {
    id: 'instagram-post',
    name: 'Instagram Post',
    icon: Instagram,
    aspectRatio: '1:1',
    description: 'Square video for feed',
    suggestedDuration: '15-60 sec',
    color: 'text-purple-500',
  },
  {
    id: 'twitter',
    name: 'Twitter/X',
    icon: Twitter,
    aspectRatio: '16:9',
    description: 'Landscape video for Twitter',
    suggestedDuration: '30-140 sec',
    color: 'text-blue-400',
  },
];

interface ProjectTemplatesProps {
  currentAspectRatio: '16:9' | '9:16';
  onSelectTemplate: (aspectRatio: '16:9' | '9:16') => void;
}

export default function ProjectTemplates({ currentAspectRatio, onSelectTemplate }: ProjectTemplatesProps) {
  const [isOpen, setIsOpen] = useState(false);

  const currentTemplate = TEMPLATES.find(t =>
    t.aspectRatio === currentAspectRatio || (currentAspectRatio === '16:9' && t.aspectRatio === '1:1')
  );

  const handleSelect = (template: ProjectTemplate) => {
    // Map 1:1 to 16:9 for now (until 1:1 is properly supported)
    const ratio = template.aspectRatio === '1:1' ? '16:9' : template.aspectRatio;
    onSelectTemplate(ratio);
    setIsOpen(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-2 bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 rounded-lg text-sm font-medium transition-colors"
      >
        <Layout className="w-4 h-4 text-zinc-600 dark:text-zinc-400" />
        <span className="text-zinc-700 dark:text-zinc-300">{currentAspectRatio}</span>
        <ChevronDown className={`w-3.5 h-3.5 text-zinc-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />

          {/* Dropdown */}
          <div className="absolute top-full left-0 mt-2 w-64 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-xl z-50 overflow-hidden">
            <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-700">
              <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Project Templates</span>
            </div>

            <div className="max-h-80 overflow-y-auto py-1">
              {TEMPLATES.map((template) => {
                const Icon = template.icon;
                const isSelected = template.aspectRatio === currentAspectRatio ||
                  (currentAspectRatio === '16:9' && template.aspectRatio === '1:1' && template.id === 'instagram-post');

                return (
                  <button
                    key={template.id}
                    onClick={() => handleSelect(template)}
                    className={`w-full flex items-start gap-3 px-3 py-2.5 hover:bg-zinc-100 dark:hover:bg-zinc-700/50 transition-colors ${
                      isSelected ? 'bg-orange-500/10' : ''
                    }`}
                  >
                    <Icon className={`w-5 h-5 mt-0.5 ${template.color}`} />
                    <div className="flex-1 text-left">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-zinc-900 dark:text-white">{template.name}</span>
                        <span className="text-[10px] px-1.5 py-0.5 bg-zinc-200 dark:bg-zinc-700 rounded text-zinc-600 dark:text-zinc-400">
                          {template.aspectRatio}
                        </span>
                        {isSelected && <Check className="w-3.5 h-3.5 text-orange-500" />}
                      </div>
                      <p className="text-xs text-zinc-500 mt-0.5">{template.description}</p>
                      {template.suggestedDuration && (
                        <p className="text-[10px] text-zinc-400 dark:text-zinc-600 mt-0.5">Suggested: {template.suggestedDuration}</p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="px-3 py-2 border-t border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50">
              <p className="text-[10px] text-zinc-500 dark:text-zinc-600 text-center">
                Select a template to set the aspect ratio
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
