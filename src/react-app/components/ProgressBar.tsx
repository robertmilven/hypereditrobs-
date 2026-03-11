import { X } from 'lucide-react';

interface ProgressBarProps {
  progress: number; // 0-100
  label?: string;
  status?: string;
  variant?: 'default' | 'success' | 'error';
  showPercentage?: boolean;
  onCancel?: () => void;
  indeterminate?: boolean;
}

export default function ProgressBar({
  progress,
  label,
  status,
  variant = 'default',
  showPercentage = true,
  onCancel,
  indeterminate = false,
}: ProgressBarProps) {
  const clampedProgress = Math.min(100, Math.max(0, progress));

  const barColor = {
    default: 'bg-gradient-to-r from-orange-500 to-amber-500',
    success: 'bg-gradient-to-r from-green-500 to-emerald-500',
    error: 'bg-gradient-to-r from-red-500 to-rose-500',
  }[variant];

  return (
    <div className="w-full">
      {/* Header */}
      {(label || showPercentage || onCancel) && (
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2 min-w-0">
            {label && (
              <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300 truncate">
                {label}
              </span>
            )}
            {status && (
              <span className="text-[10px] text-zinc-500 truncate">
                {status}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {showPercentage && !indeterminate && (
              <span className="text-xs font-mono text-zinc-600 dark:text-zinc-400">
                {Math.round(clampedProgress)}%
              </span>
            )}
            {onCancel && (
              <button
                onClick={onCancel}
                className="p-0.5 hover:bg-zinc-200 dark:hover:bg-zinc-700 rounded transition-colors"
                title="Cancel"
              >
                <X className="w-3 h-3 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Progress bar */}
      <div className="h-1.5 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
        {indeterminate ? (
          <div
            className={`h-full w-1/3 ${barColor} rounded-full animate-[progress-indeterminate_1.5s_ease-in-out_infinite]`}
          />
        ) : (
          <div
            className={`h-full ${barColor} rounded-full transition-all duration-300 ease-out`}
            style={{ width: `${clampedProgress}%` }}
          />
        )}
      </div>
    </div>
  );
}

// Compact inline version for status bars
export function InlineProgress({
  progress,
  label,
  indeterminate = false,
}: {
  progress: number;
  label?: string;
  indeterminate?: boolean;
}) {
  const clampedProgress = Math.min(100, Math.max(0, progress));

  return (
    <div className="flex items-center gap-2">
      {label && (
        <span className="text-[10px] text-zinc-500 whitespace-nowrap">{label}</span>
      )}
      <div className="w-16 h-1 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
        {indeterminate ? (
          <div className="h-full w-1/3 bg-orange-500 rounded-full animate-[progress-indeterminate_1.5s_ease-in-out_infinite]" />
        ) : (
          <div
            className="h-full bg-orange-500 rounded-full transition-all duration-200"
            style={{ width: `${clampedProgress}%` }}
          />
        )}
      </div>
      {!indeterminate && (
        <span className="text-[10px] font-mono text-zinc-500">{Math.round(clampedProgress)}%</span>
      )}
    </div>
  );
}
