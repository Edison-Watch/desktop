import type { Meta, StoryObj } from '@storybook/react-vite';
import FinishStep from './FinishStep';

const meta: Meta<typeof FinishStep> = {
  title: 'Client2/FinishStep',
  component: FinishStep,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

const BASE_PROPS = {
  email: 'alice@example.com',
  userId: 'demo-user-1',
  apiKey: 'edison_demo_apikey_abc123',
  mcpBaseUrl: 'https://mcp.demo.example.com',
  apiBaseUrl: 'https://api.demo.example.com',
  selectedApps: ['cursor', 'claude-code'],
  onComplete: () => {},
  onRestart: () => {},
};

/** Setup complete, server online, with modified app configs. */
export const WithModifiedConfigs: Story = {
  args: {
    ...BASE_PROPS,
    serverStatus: 'online',
    modifiedConfigs: [
      {
        appId: 'cursor',
        configPath: '/Users/alice/.cursor/mcp.json',
        backupPath: '/Users/alice/.cursor/mcp.json.bak',
      },
      {
        appId: 'claude-code',
        configPath: '/Users/alice/.claude/mcp.json',
        backupPath: '/Users/alice/.claude/mcp.json.bak',
      },
    ],
    edisonSecretKey: 'edison_secret_demo',
  },
  decorators: [
    (Story) => (
      <div style={{ width: '400px' }}>
        <Story />
      </div>
    ),
  ],
};

/** Setup complete, no app configs modified (skipped apps step). */
export const NoConfigsModified: Story = {
  args: {
    ...BASE_PROPS,
    serverStatus: 'online',
    modifiedConfigs: [],
  },
  decorators: [
    (Story) => (
      <div style={{ width: '400px' }}>
        <Story />
      </div>
    ),
  ],
};

/** Server currently offline. */
export const ServerOffline: Story = {
  args: {
    ...BASE_PROPS,
    serverStatus: 'offline',
    modifiedConfigs: [],
  },
  decorators: [
    (Story) => (
      <div style={{ width: '400px' }}>
        <Story />
      </div>
    ),
  ],
};
