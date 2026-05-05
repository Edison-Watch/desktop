/**
 * App logos for MCP client discovery.
 *
 * Icon data sourced from @edison/shared/agent-registry (simple-icons, MIT license).
 * Claude Cowork and VS Code use local PNG assets for best rendering quality in the
 * Electron context (VS Code's SVG path exists in the registry but the PNG looks
 * better at the 32 px display size used here).
 */
import {
  AGENT_REGISTRY,
  type AgentId,
} from "@edison/shared/agent-registry";
import vscodePng from "../assets/logo-vscode.png";
import claudeCoworkPng from "../assets/logo-claude-cowork.png";

interface AppLogoProps {
  id: string;
  name: string;
}

export function AppLogo({ id, name }: AppLogoProps) {
  // --- PNG overrides (assets that can't be expressed as SVG paths) ---

  if (id === "claude-cowork") {
    return (
      <img
        src={claudeCoworkPng}
        alt={name}
        className="h-8 w-8 shrink-0 rounded-lg object-cover"
      />
    );
  }

  if (id === "vscode") {
    return (
      <img
        src={vscodePng}
        alt={name}
        className="h-8 w-8 shrink-0 rounded-lg object-contain"
      />
    );
  }

  // --- Registry-driven rendering ---

  const entry = AGENT_REGISTRY[id as AgentId];

  if (entry?.svgPath) {
    return (
      <div
        className="h-8 w-8 shrink-0 overflow-hidden rounded-lg flex items-center justify-center p-1.5 ring-1 ring-black/10"
        style={{ background: entry.brandColor }}
        aria-label={name}
      >
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" className="h-full w-full" aria-hidden="true">
          <path d={entry.svgPath} fill={entry.svgFill ?? "white"} />
        </svg>
      </div>
    );
  }

  if (entry?.customSvg) {
    return (
      <div
        className="h-8 w-8 shrink-0 overflow-hidden rounded-lg flex items-center justify-center"
        style={{ background: entry.brandColor }}
        aria-label={name}
      >
        <svg
          viewBox={entry.customViewBox ?? "0 0 24 24"}
          xmlns="http://www.w3.org/2000/svg"
          className="h-full w-full"
          shapeRendering={entry.crispEdges ? "crispEdges" : undefined}
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: entry.customSvg }}
        />
      </div>
    );
  }

  // --- Fallback: first-letter badge ---
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-input)] text-sm font-medium text-[var(--text-secondary)]">
      {name[0]}
    </div>
  );
}
