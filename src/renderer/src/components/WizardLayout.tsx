import StepIndicator from "./StepIndicator";
import logoDark from "../assets/logo-dark.png";

interface WizardLayoutProps {
  currentStep: number;
  maxVisitedStep?: number;
  locked?: boolean;
  onStepClick?: (step: number) => void;
  children: React.ReactNode;
}

export default function WizardLayout({ currentStep, maxVisitedStep, locked, onStepClick, children }: WizardLayoutProps): React.ReactNode {
  return (
    <div className="flex h-screen flex-col items-center overflow-y-auto bg-[var(--bg-base)]">
      {/* Header with branding */}
      <header className="flex w-full flex-col items-center gap-3 px-6 pt-8 pb-4">
        <img src={logoDark} alt="Edison Watch" className="h-7 w-auto" />
        <StepIndicator currentStep={currentStep} maxVisitedStep={maxVisitedStep} locked={locked} onStepClick={onStepClick} />
      </header>

      {/* Content area */}
      <main className="flex w-full max-w-lg flex-1 flex-col px-6 pb-8">
        {children}
      </main>
    </div>
  );
}
