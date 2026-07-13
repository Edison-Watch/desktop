import { useState, useEffect } from "react";
import WizardLayout from "./components/WizardLayout";
import WelcomeStep from "./components/WelcomeStep";
import AppsStep from "./components/AppsStep";
import type { ModifiedConfig, DiscoveredServer, RemovalTarget, DuplicateSelections } from "./components/AppsStep";
import EncryptionStep from "./components/EncryptionStep";
import FinishStep from "./components/FinishStep";
import MainMenu from "./components/MainMenu";
import useAuth from "./hooks/useAuth";

export default function App(): React.ReactNode {
  const [currentStep, setCurrentStep] = useState(0);
  const [maxVisitedStep, setMaxVisitedStep] = useState(0);

  const goToStep = (step: number) => {
    setCurrentStep(step);
    setMaxVisitedStep((prev) => Math.max(prev, step));
  };
  const [setupDone, setSetupDone] = useState<boolean | null>(null);
  const [selectedApps, setSelectedApps] = useState<string[] | null>(null);
  const [discoveredServers, setDiscoveredServers] = useState<DiscoveredServer[]>([]);
  const [serversToRemove, setServersToRemove] = useState<RemovalTarget[]>([]);
  const [skipServers, setSkipServers] = useState<string[]>([]);
  const [duplicateSelections, setDuplicateSelections] = useState<DuplicateSelections | null>(null);
  const [modifiedConfigs, setModifiedConfigs] = useState<ModifiedConfig[]>([]);
  const [edisonSecretKey, setEdisonSecretKey] = useState("");
  const auth = useAuth();

  // Check if setup was already completed on mount
  useEffect(() => {
    (async () => {
      try {
        const data = await window.api.setup.getData();
        setSetupDone(data?.completed ? true : false);
      } catch (err) {
        console.error("[App] Failed to check setup state:", err);
        setSetupDone(false);
      }
    })();
  }, []);

  // Hand the daemon the credentials as soon as the user is signed in (Continue
  // past the login window) so it enrolls right away. A returning login keeps
  // its API key only in this renderer's auth state; main's setup file has no
  // key for the active env, so app-ready's bootstrap can't do this on its own.
  // Enroll is additive (agents union) and non-destructive (a missing secret
  // keeps the existing one), so it's safe to (re-)send on every sign-in. Before
  // app selection there are no configured agents yet, so this is a base enroll
  // (url + key); onboarding's setup:complete adds the chosen agents.
  useEffect(() => {
    if (!auth.signedIn || !auth.apiKey || !auth.apiBaseUrl) return;
    window.api.detectord
      .enroll({
        apiUrl: auth.apiBaseUrl,
        mcpUrl: auth.mcpBaseUrl,
        apiKey: auth.apiKey,
        edisonSecretKey: edisonSecretKey || undefined,
      })
      .catch((err) => console.error("[App] detectord enroll push failed:", err));
  }, [auth.signedIn, auth.apiKey, auth.apiBaseUrl, auth.mcpBaseUrl, edisonSecretKey]);

  // Windows: right-click in the app body opens the app menu (skip editable
  // fields/selections); the title bar keeps the OS system menu.
  useEffect(() => {
    if (window.api.platform !== "win32") return;
    const onContextMenu = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || el.closest("input, textarea"))) return;
      if ((window.getSelection()?.toString().length ?? 0) > 0) return;
      e.preventDefault();
      void window.api.menu.popupApp();
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  const handleWelcomeNext = () => {
    if (auth.signedIn) goToStep(1);
  };

  const handleAppsNext = (apps: string[], servers: DiscoveredServer[], removedServers: RemovalTarget[], dupeSelections: DuplicateSelections, skip: string[]) => {
    setSelectedApps(apps);
    setDiscoveredServers(servers);
    setServersToRemove(removedServers);
    setDuplicateSelections(dupeSelections);
    setSkipServers(skip);
    goToStep(2);
  };

  const handleEncryptionNext = (compositeKey: string, configs: ModifiedConfig[]) => {
    setEdisonSecretKey(compositeKey);
    setModifiedConfigs(configs);
    window.api.setup.reachedFinal();
    goToStep(3);
  };

  const handleRestart = () => {
    setModifiedConfigs([]);
    setEdisonSecretKey("");
    setSelectedApps(null);
    setServersToRemove([]);
    goToStep(1);
  };

  const handleComplete = () => {
    setSetupDone(true);
  };

  // Loading: checking if setup was previously completed
  if (setupDone === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg-base)]">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
      </div>
    );
  }

  // Setup already complete - show the main menu
  if (setupDone === true) {
    return <MainMenu />;
  }

  return (
    <WizardLayout
      currentStep={currentStep}
      maxVisitedStep={maxVisitedStep}
      locked={currentStep === 3}
      onStepClick={goToStep}
    >
      {currentStep === 0 && <WelcomeStep auth={auth} onNext={handleWelcomeNext} />}
      {currentStep === 1 && (
        <AppsStep
          onNext={handleAppsNext}
          initialSelectedApps={selectedApps}
          initialDuplicateSelections={duplicateSelections}
        />
      )}
      {currentStep === 2 && (
        <EncryptionStep
          mcpBaseUrl={auth.mcpBaseUrl}
          apiBaseUrl={auth.apiBaseUrl}
          apiKey={auth.apiKey}
          userId={auth.userId}
          selectedApps={selectedApps ?? []}
          discoveredServers={discoveredServers}
          serversToRemove={serversToRemove}
          skipServers={skipServers}
          autoQuarantine={auth.autoQuarantineOtherMcpServers}
          onNext={handleEncryptionNext}
        />
      )}
      {currentStep === 3 && (
        <FinishStep
          email={auth.email}
          userId={auth.userId}
          apiKey={auth.apiKey}
          mcpBaseUrl={auth.mcpBaseUrl}
          apiBaseUrl={auth.apiBaseUrl}
          serverStatus={auth.serverStatus}
          modifiedConfigs={modifiedConfigs}
          edisonSecretKey={edisonSecretKey}
          selectedApps={selectedApps ?? []}
          onComplete={handleComplete}
          onRestart={handleRestart}
        />
      )}
    </WizardLayout>
  );
}
