import { useState, useEffect, useCallback } from 'react';

export interface RecentProject {
  id: string;
  name: string;
  lastModified: number;
  thumbnail?: string;
  assetCount: number;
  clipCount: number;
}

const STORAGE_KEY = 'hyperedit-recent-projects';
const MAX_RECENT = 10;

function getStoredProjects(): RecentProject[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to load recent projects:', e);
  }
  return [];
}

function saveStoredProjects(projects: RecentProject[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
  } catch (e) {
    console.error('Failed to save recent projects:', e);
  }
}

export function useRecentProjects() {
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>(() => getStoredProjects());

  // Sync with localStorage
  useEffect(() => {
    saveStoredProjects(recentProjects);
  }, [recentProjects]);

  // Add or update a project
  const addProject = useCallback((project: Omit<RecentProject, 'lastModified'>) => {
    setRecentProjects(prev => {
      // Remove existing entry for this project
      const filtered = prev.filter(p => p.id !== project.id);

      // Add to the front with current timestamp
      const updated: RecentProject = {
        ...project,
        lastModified: Date.now(),
      };

      // Keep only MAX_RECENT projects
      return [updated, ...filtered].slice(0, MAX_RECENT);
    });
  }, []);

  // Remove a project from recents
  const removeProject = useCallback((projectId: string) => {
    setRecentProjects(prev => prev.filter(p => p.id !== projectId));
  }, []);

  // Clear all recent projects
  const clearAll = useCallback(() => {
    setRecentProjects([]);
  }, []);

  // Format relative time
  const formatRelativeTime = useCallback((timestamp: number): string => {
    const now = Date.now();
    const diff = now - timestamp;

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;

    return new Date(timestamp).toLocaleDateString();
  }, []);

  return {
    recentProjects,
    addProject,
    removeProject,
    clearAll,
    formatRelativeTime,
  };
}
