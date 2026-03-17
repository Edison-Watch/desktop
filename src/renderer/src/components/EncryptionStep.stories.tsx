import type { Meta, StoryObj } from '@storybook/react-vite';
import EncryptionStep from './EncryptionStep';

const meta: Meta<typeof EncryptionStep> = {
  title: 'Client2/EncryptionStep',
  component: EncryptionStep,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

const BASE_PROPS = {
  mcpBaseUrl: 'https://mcp.demo.example.com',
  apiBaseUrl: 'https://api.demo.example.com',
  apiKey: 'edison_demo_apikey_abc123',
  userId: 'demo-user-1',
  selectedApps: ['cursor', 'claude-code'],
  discoveredServers: [
    { name: '@modelcontextprotocol/server-filesystem', client: 'cursor', source: 'mcp_config.json' },
    { name: '@modelcontextprotocol/server-github', client: 'claude-code', source: 'mcp_config.json' },
  ],
  onNext: () => {},
};

/** Initial state — no keys entered yet. */
export const Initial: Story = {
  args: BASE_PROPS,
  decorators: [
    (Story) => (
      <div style={{ width: '420px' }}>
        <Story />
      </div>
    ),
  ],
};

/** No apps selected — shows "Continue" CTA. */
export const NoAppsSelected: Story = {
  args: {
    ...BASE_PROPS,
    selectedApps: [],
    discoveredServers: [],
  },
  decorators: [
    (Story) => (
      <div style={{ width: '420px' }}>
        <Story />
      </div>
    ),
  ],
};
