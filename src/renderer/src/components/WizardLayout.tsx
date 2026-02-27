import StepIndicator from "./StepIndicator";

interface WizardLayoutProps {
  currentStep: number;
  locked?: boolean;
  children: React.ReactNode;
}

export default function WizardLayout({ currentStep, locked, children }: WizardLayoutProps): React.ReactNode {
  return (
    <div className="flex min-h-screen flex-col items-center bg-[var(--bg-base)]">
      {/* Header with branding */}
      <header className="flex w-full flex-col items-center gap-4 px-6 pt-10 pb-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-[var(--accent)] to-[var(--accent-muted)]">
            <span className="text-lg font-bold text-[var(--bg-base)]">E</span>
          </div>
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">Edison Watch</h1>
        </div>
        <StepIndicator currentStep={currentStep} locked={locked} />
      </header>

      {/* Content area */}
      <main className="flex w-full max-w-md flex-1 flex-col px-6 pb-10">
        {children}
      </main>
    </div>
  );
}
