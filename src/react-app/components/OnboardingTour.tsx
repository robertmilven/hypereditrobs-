import { useState, useEffect } from 'react';
import { X, ArrowRight, ArrowLeft, Sparkles, Upload, Scissors, Wand2, CheckCircle } from 'lucide-react';

interface TourStep {
  id: string;
  title: string;
  description: string;
  icon: typeof Sparkles;
  highlight?: string; // CSS selector for element to highlight
  position: 'center' | 'left' | 'right' | 'bottom';
}

const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to HyperEdit',
    description: 'Your AI-powered video editor. Let\'s take a quick tour of the main features!',
    icon: Sparkles,
    position: 'center',
  },
  {
    id: 'assets',
    title: 'Asset Library',
    description: 'Upload your videos, images, and audio files here. Drag them to the timeline to start editing. You\'ll also find free resources from Pexels, Pixabay, and more!',
    icon: Upload,
    position: 'left',
  },
  {
    id: 'timeline',
    title: 'Timeline Editor',
    description: 'This is where the magic happens! Arrange your clips, trim them, and build your video. Use multiple tracks for layering.',
    icon: Scissors,
    position: 'bottom',
  },
  {
    id: 'ai-panel',
    title: 'AI Director',
    description: 'Ask the AI to help you edit! Try commands like "remove background noise", "add captions", or "create an animation". The AI understands natural language.',
    icon: Wand2,
    position: 'right',
  },
  {
    id: 'done',
    title: 'You\'re Ready!',
    description: 'That\'s it! Start by uploading a video or exploring the AI features. Press "?" anytime to see keyboard shortcuts.',
    icon: CheckCircle,
    position: 'center',
  },
];

const STORAGE_KEY = 'hyperedit-onboarding-complete';

interface OnboardingTourProps {
  forceShow?: boolean;
  onComplete?: () => void;
}

export default function OnboardingTour({ forceShow, onComplete }: OnboardingTourProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (forceShow) {
      setIsVisible(true);
      setCurrentStep(0);
    }
  }, [forceShow]);

  const handleNext = () => {
    if (currentStep < TOUR_STEPS.length - 1) {
      setCurrentStep(prev => prev + 1);
    } else {
      handleComplete();
    }
  };

  const handlePrev = () => {
    if (currentStep > 0) {
      setCurrentStep(prev => prev - 1);
    }
  };

  const handleSkip = () => {
    handleComplete();
  };

  const handleComplete = () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    setIsVisible(false);
    onComplete?.();
  };

  if (!isVisible) {
    return null;
  }

  const step = TOUR_STEPS[currentStep];
  const Icon = step.icon;
  const isFirst = currentStep === 0;
  const isLast = currentStep === TOUR_STEPS.length - 1;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={handleSkip} />

      {/* Tour card */}
      <div className="relative bg-white dark:bg-zinc-800 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="relative bg-gradient-to-r from-orange-500 to-amber-500 px-6 py-8">
          <button
            onClick={handleSkip}
            className="absolute top-3 right-3 p-1 hover:bg-white/20 rounded-full transition-colors"
          >
            <X className="w-5 h-5 text-white/80" />
          </button>
          <div className="w-14 h-14 bg-white/20 rounded-xl flex items-center justify-center mb-4">
            <Icon className="w-8 h-8 text-white" />
          </div>
          <h2 className="text-xl font-bold text-white">{step.title}</h2>
        </div>

        {/* Content */}
        <div className="px-6 py-5">
          <p className="text-zinc-600 dark:text-zinc-300 leading-relaxed">
            {step.description}
          </p>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-zinc-50 dark:bg-zinc-900/50 border-t border-zinc-200 dark:border-zinc-700 flex items-center justify-between">
          {/* Progress dots */}
          <div className="flex items-center gap-1.5">
            {TOUR_STEPS.map((_, index) => (
              <div
                key={index}
                className={`w-2 h-2 rounded-full transition-colors ${
                  index === currentStep
                    ? 'bg-orange-500'
                    : index < currentStep
                    ? 'bg-orange-300'
                    : 'bg-zinc-300 dark:bg-zinc-600'
                }`}
              />
            ))}
          </div>

          {/* Navigation buttons */}
          <div className="flex items-center gap-2">
            {!isFirst && (
              <button
                onClick={handlePrev}
                className="flex items-center gap-1 px-3 py-1.5 text-sm text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 rounded-lg transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
                Back
              </button>
            )}
            <button
              onClick={handleNext}
              className="flex items-center gap-1 px-4 py-1.5 text-sm font-medium bg-orange-500 hover:bg-orange-600 text-white rounded-lg transition-colors"
            >
              {isLast ? 'Get Started' : 'Next'}
              {!isLast && <ArrowRight className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Helper hook to manage onboarding state
export function useOnboarding() {
  const [showTour, setShowTour] = useState(false);

  const resetTour = () => {
    localStorage.removeItem(STORAGE_KEY);
    setShowTour(true);
  };

  const startTour = () => {
    setShowTour(true);
  };

  const completeTour = () => {
    setShowTour(false);
  };

  const hasCompletedTour = () => {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  };

  return {
    showTour,
    setShowTour,
    resetTour,
    startTour,
    completeTour,
    hasCompletedTour,
  };
}
