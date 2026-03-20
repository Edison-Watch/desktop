const steps = ["Welcome", "Apps", "Encrypt & Submit", "Finish"];

function CheckIcon() {
  return (
    <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3" aria-hidden="true">
      <path d="M2.5 6l2.5 2.5 4.5-4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface StepIndicatorProps {
  currentStep: number;
  maxVisitedStep?: number;
  locked?: boolean;
  onStepClick?: (step: number) => void;
}

export default function StepIndicator({ currentStep, maxVisitedStep, locked, onStepClick }: StepIndicatorProps): React.ReactNode {
  const highWater = maxVisitedStep ?? currentStep;
  return (
    <div className={`flex items-center gap-1 ${locked ? "pointer-events-none opacity-60" : ""}`}>
      {steps.map((label, i) => {
        const isComplete = i < currentStep;
        const isActive = i === currentStep;
        const isClickable = i !== currentStep && i <= highWater && !!onStepClick;
        return (
          <div key={label} className="flex items-center gap-1">
            {i > 0 && (
              <div
                className={`h-px w-4 transition-colors ${isComplete ? "bg-[var(--accent)]" : "bg-[var(--border)]"}`}
              />
            )}
            <div
              className={`flex items-center gap-1.5 rounded-full py-1 px-1.5 transition-colors ${isClickable ? "cursor-pointer hover:bg-[var(--bg-hover)]" : ""}`}
              onClick={isClickable ? () => onStepClick(i) : undefined}
            >
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold transition-all ${
                  isComplete
                    ? "bg-[var(--accent)] text-[var(--bg-base)]"
                    : isActive
                      ? "border-2 border-[var(--accent)] text-[var(--accent)]"
                      : "border border-[var(--border)] text-[var(--text-muted)]"
                }`}
              >
                {isComplete ? <CheckIcon /> : i + 1}
              </span>
              <span
                className={`text-xs font-medium transition-colors ${
                  isActive ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"
                }`}
              >
                {label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
