const steps = ["Welcome", "Apps", "Encrypt & Submit", "Finish"];

interface StepIndicatorProps {
  currentStep: number;
  locked?: boolean;
  onStepClick?: (step: number) => void;
}

export default function StepIndicator({ currentStep, locked, onStepClick }: StepIndicatorProps): React.ReactNode {
  return (
    <div className={`flex items-center gap-2 ${locked ? "pointer-events-none opacity-60" : ""}`}>
      {steps.map((label, i) => {
        const isComplete = i < currentStep;
        const isActive = i === currentStep;
        const isClickable = isComplete && !!onStepClick;
        return (
          <div key={label} className="flex items-center gap-2">
            {i > 0 && (
              <div
                className={`h-px w-6 ${isComplete ? "bg-[var(--accent)]" : "bg-[var(--border)]"}`}
              />
            )}
            <div
              className={`flex items-center gap-1.5 ${isClickable ? "cursor-pointer group/step" : ""}`}
              onClick={isClickable ? () => onStepClick(i) : undefined}
            >
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium transition-opacity ${
                  isComplete
                    ? "bg-[var(--accent)] text-[var(--bg-base)] group-hover/step:opacity-75"
                    : isActive
                      ? "border border-[var(--accent)] text-[var(--accent)]"
                      : "border border-[var(--border)] text-[var(--text-muted)]"
                }`}
              >
                {isComplete ? "✓" : i + 1}
              </span>
              <span
                className={`text-sm transition-opacity ${
                  isActive ? "text-[var(--text-primary)]" : isComplete ? "text-[var(--text-muted)] group-hover/step:opacity-75" : "text-[var(--text-muted)]"
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
