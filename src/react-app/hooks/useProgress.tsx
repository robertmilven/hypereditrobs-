import { createContext, useContext, useState, useCallback, ReactNode } from 'react';

export interface ProgressTask {
  id: string;
  label: string;
  progress: number; // 0-100
  status?: string;
  variant?: 'default' | 'success' | 'error';
  indeterminate?: boolean;
  startTime: number;
}

interface ProgressContextType {
  tasks: ProgressTask[];
  startTask: (id: string, label: string, indeterminate?: boolean) => void;
  updateTask: (id: string, progress: number, status?: string) => void;
  completeTask: (id: string, variant?: 'success' | 'error') => void;
  cancelTask: (id: string) => void;
}

const ProgressContext = createContext<ProgressContextType | undefined>(undefined);

export function ProgressProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<ProgressTask[]>([]);

  const startTask = useCallback((id: string, label: string, indeterminate = false) => {
    setTasks(prev => {
      // Remove existing task with same id
      const filtered = prev.filter(t => t.id !== id);
      return [
        ...filtered,
        {
          id,
          label,
          progress: 0,
          indeterminate,
          startTime: Date.now(),
        },
      ];
    });
  }, []);

  const updateTask = useCallback((id: string, progress: number, status?: string) => {
    setTasks(prev =>
      prev.map(task =>
        task.id === id
          ? { ...task, progress: Math.min(100, Math.max(0, progress)), status, indeterminate: false }
          : task
      )
    );
  }, []);

  const completeTask = useCallback((id: string, variant: 'success' | 'error' = 'success') => {
    setTasks(prev =>
      prev.map(task =>
        task.id === id
          ? { ...task, progress: 100, variant, indeterminate: false }
          : task
      )
    );

    // Auto-remove after a delay
    setTimeout(() => {
      setTasks(prev => prev.filter(t => t.id !== id));
    }, variant === 'success' ? 1500 : 3000);
  }, []);

  const cancelTask = useCallback((id: string) => {
    setTasks(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ProgressContext.Provider value={{ tasks, startTask, updateTask, completeTask, cancelTask }}>
      {children}
    </ProgressContext.Provider>
  );
}

export function useProgress() {
  const context = useContext(ProgressContext);
  if (context === undefined) {
    throw new Error('useProgress must be used within a ProgressProvider');
  }
  return context;
}
