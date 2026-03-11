import { useProgress } from '@/react-app/hooks/useProgress';
import ProgressBar from './ProgressBar';

export default function GlobalProgress() {
  const { tasks, cancelTask } = useProgress();

  if (tasks.length === 0) {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {tasks.map((task) => (
        <div
          key={task.id}
          className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg p-3 animate-in slide-in-from-right duration-200"
        >
          <ProgressBar
            progress={task.progress}
            label={task.label}
            status={task.status}
            variant={task.variant}
            indeterminate={task.indeterminate}
            onCancel={() => cancelTask(task.id)}
          />
        </div>
      ))}
    </div>
  );
}
