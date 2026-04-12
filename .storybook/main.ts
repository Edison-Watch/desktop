import type { StorybookConfig } from '@storybook/react-vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import tailwindcss from '@tailwindcss/vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Storybook config for client_2 (Electron renderer).
 *
 * Runs as a plain Vite + React Storybook - no Electron binaries involved.
 * Components that use window.api (Electron IPC) receive a mock in preview.tsx.
 */
const config: StorybookConfig = {
  stories: ['../src/renderer/src/**/*.stories.@(js|jsx|mjs|ts|tsx)'],
  addons: [
    '@storybook/addon-vitest',
    '@storybook/addon-a11y',
    '@storybook/addon-docs',
  ],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  async viteFinal(config) {
    config.plugins = [...(config.plugins ?? []), tailwindcss()];

    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': resolve(__dirname, '../src/renderer/src'),
      '@edison/shared': resolve(__dirname, '../../packages/shared/src'),
    };
    config.server = config.server || {};
    config.server.fs = config.server.fs || {};
    config.server.fs.allow = [
      ...(config.server.fs.allow || []),
      resolve(__dirname, '../../'),
    ];
    return config;
  },
};

export default config;
