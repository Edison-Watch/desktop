import type { Preview } from '@storybook/react-vite';
import React from 'react';
import '../src/renderer/src/assets/main.css';

// ── Mock window.api (Electron IPC) ───────────────────────────────────────────
//
// In Storybook, the Electron preload script does not run, so window.api is
// undefined. Provide a no-op stub so components don't crash on import/render.
//
(window as Window & { api?: unknown }).api = {
  setup: {
    getData: async () => null,
    reachedFinal: () => {},
    complete: async () => {},
  },
  auth: {
    onCallback: (_cb: (url: string) => void) => () => {},
    getDevCallbackUrl: async () => '',
  },
  config: {
    getEffectiveBaseUrls: async () => ({ mcpBaseUrl: '', apiBaseUrl: '' }),
    getActiveEnv: async () => 'prod',
    onEnvChanged: (_cb: (env: string) => void) => {},
  },
  shell: {
    openExternal: (_url: string) => {},
  },
  health: {
    check: async () => true,
  },
  menu: {
    getVersion: async () => '1.0.0',
    resizeWindow: async () => {},
    getMcpConfig: async () => '{"mcpServers":{"edison-watch":{"url":"https://mcp.demo.example.com/mcp/key"}}}',
    openFeedback: () => {},
  },
  mcp: {
    detectClients: async () => [],
    readConfig: async () => '',
    discover: async () => [],
    submitAllDiscovered: async () => ({ submitted: 0, autoApproved: 0, skipped: 0, total: 0 }),
    applyAppIntegrations: async () => ({ modifiedConfigs: [] }),
    revertAppIntegrations: async () => ({ reverted: 0, errors: [] }),
  },
};

// Mock Date.now() for deterministic visual snapshots
const MOCK_TIMESTAMP = new Date('2025-01-15T12:00:00Z').getTime();
Date.now = () => MOCK_TIMESTAMP;

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    a11y: {
      test: 'todo',
    },
    backgrounds: {
      disable: true,
    },
  },
  decorators: [
    (Story) => (
      <div
        data-theme="dark"
        style={{ minHeight: '100vh', background: 'var(--bg-base)', color: 'var(--text-primary)', padding: '1.5rem' }}
      >
        <Story />
      </div>
    ),
  ],
};

export default preview;
