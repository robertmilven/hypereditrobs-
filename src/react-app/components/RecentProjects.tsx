import { useState } from 'react';
import { Clock, Folder, Trash2, ChevronDown, Film, X } from 'lucide-react';
import { useRecentProjects, RecentProject } from '@/react-app/hooks/useRecentProjects';

interface RecentProjectsProps {
  currentProjectId?: string;
  onSelectProject?: (project: RecentProject) => void;
}

export default function RecentProjects({ currentProjectId, onSelectProject }: RecentProjectsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { recentProjects, removeProject, clearAll, formatRelativeTime } = useRecentProjects();

  if (recentProjects.length === 0) {
    return null;
  }

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-2 bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 rounded-lg text-sm font-medium transition-colors"
        title="Recent Projects"
      >
        <Clock className="w-4 h-4 text-zinc-600 dark:text-zinc-400" />
        <span className="text-zinc-700 dark:text-zinc-300 hidden sm:inline">Recent</span>
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
          <div className="absolute top-full left-0 mt-2 w-72 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-xl z-50 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-200 dark:border-zinc-700">
              <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Recent Projects</span>
              {recentProjects.length > 0 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm('Clear all recent projects?')) {
                      clearAll();
                    }
                  }}
                  className="text-xs text-zinc-400 hover:text-red-400 transition-colors"
                >
                  Clear all
                </button>
              )}
            </div>

            <div className="max-h-80 overflow-y-auto py-1">
              {recentProjects.map((project) => {
                const isCurrent = project.id === currentProjectId;

                return (
                  <div
                    key={project.id}
                    className={`group flex items-start gap-3 px-3 py-2.5 hover:bg-zinc-100 dark:hover:bg-zinc-700/50 transition-colors ${
                      isCurrent ? 'bg-orange-500/10' : ''
                    }`}
                  >
                    {/* Thumbnail or icon */}
                    <div className="w-10 h-10 rounded-lg bg-zinc-200 dark:bg-zinc-700 flex items-center justify-center flex-shrink-0 overflow-hidden">
                      {project.thumbnail ? (
                        <img src={project.thumbnail} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <Folder className="w-5 h-5 text-zinc-400" />
                      )}
                    </div>

                    {/* Project info */}
                    <button
                      onClick={() => {
                        onSelectProject?.(project);
                        setIsOpen(false);
                      }}
                      className="flex-1 text-left min-w-0"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-zinc-900 dark:text-white truncate">
                          {project.name}
                        </span>
                        {isCurrent && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-orange-500 rounded text-white">
                            Current
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-zinc-500">
                          {formatRelativeTime(project.lastModified)}
                        </span>
                        <span className="text-zinc-300 dark:text-zinc-600">|</span>
                        <span className="text-xs text-zinc-500 flex items-center gap-1">
                          <Film className="w-3 h-3" />
                          {project.clipCount} clips
                        </span>
                      </div>
                    </button>

                    {/* Delete button */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeProject(project.id);
                      }}
                      className="p-1 opacity-0 group-hover:opacity-100 hover:bg-red-500/20 rounded transition-all"
                      title="Remove from recents"
                    >
                      <X className="w-3.5 h-3.5 text-zinc-400 hover:text-red-400" />
                    </button>
                  </div>
                );
              })}
            </div>

            {recentProjects.length === 0 && (
              <div className="px-4 py-6 text-center">
                <Clock className="w-8 h-8 text-zinc-300 dark:text-zinc-600 mx-auto mb-2" />
                <p className="text-sm text-zinc-500">No recent projects</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
