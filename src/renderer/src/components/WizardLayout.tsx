import StepIndicator from "./StepIndicator";
import logoDark from "../assets/logo-dark.png";

interface WizardLayoutProps {
  currentStep: number;
  locked?: boolean;
  children: React.ReactNode;
}

export default function WizardLayout({ currentStep, locked, children }: WizardLayoutProps): React.ReactNode {
  return (
    <div className="flex h-screen flex-col items-center overflow-y-auto bg-[var(--bg-base)]">
      {/* Header with branding */}
      <header className="flex w-full flex-col items-center gap-4 px-6 pt-10 pb-6">
        <img src={logoDark} alt="Edison Watch" className="h-8 w-auto" />
        <StepIndicator currentStep={currentStep} locked={locked} />
      </header>

      {/* Content area */}
      <main className="flex w-full max-w-lg flex-1 flex-col px-6 pb-10">
        {children}
      </main>
    </div>
  );
}
