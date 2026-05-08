import type { Meta, StoryObj } from '@storybook/react-vite';
import WelcomeStep from './WelcomeStep';

const meta: Meta<typeof WelcomeStep> = {
  title: 'Client2/WelcomeStep',
  component: WelcomeStep,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

const baseAuth: Parameters<typeof WelcomeStep>[0]['auth'] = {
  loading: false,
  error: '',
  warning: '',
  awaitingBrowserCallback: false,
  pendingAuthMethod: null,
  signedIn: false,
  email: '',
  userId: '',
  apiKey: '',
  mcpBaseUrl: '',
  apiBaseUrl: '',
  ssoOnly: false,
  autoQuarantineOtherMcpServers: false,
  serverStatus: 'checking',
  signInWithSSO: async () => {},
  signInWithGoogle: async () => {},
  signInWithMicrosoft: async () => {},
  signInWithPassword: async () => {},
  checkDomain: () => {},
  cancelPendingAuth: () => {},
};

export const SignInForm: Story = {
  args: {
    auth: baseAuth,
    onNext: () => {},
  },
  decorators: [
    (Story) => (
      <div style={{ width: '360px' }}>
        <Story />
      </div>
    ),
  ],
};

export const SSOOnly: Story = {
  args: {
    auth: { ...baseAuth, ssoOnly: true },
    onNext: () => {},
  },
  decorators: [
    (Story) => (
      <div style={{ width: '360px' }}>
        <Story />
      </div>
    ),
  ],
};

export const Loading: Story = {
  args: {
    auth: { ...baseAuth, loading: true },
    onNext: () => {},
  },
  decorators: [
    (Story) => (
      <div style={{ width: '360px' }}>
        <Story />
      </div>
    ),
  ],
};

export const WithError: Story = {
  args: {
    auth: { ...baseAuth, error: 'Invalid credentials. Please try again.' },
    onNext: () => {},
  },
  decorators: [
    (Story) => (
      <div style={{ width: '360px' }}>
        <Story />
      </div>
    ),
  ],
};

export const SignedIn: Story = {
  args: {
    auth: { ...baseAuth, signedIn: true, email: 'alice@example.com', serverStatus: 'online' },
    onNext: () => {},
  },
  decorators: [
    (Story) => (
      <div style={{ width: '360px' }}>
        <Story />
      </div>
    ),
  ],
};

export const SignedInOffline: Story = {
  args: {
    auth: { ...baseAuth, signedIn: true, email: 'alice@example.com', serverStatus: 'offline' },
    onNext: () => {},
  },
  decorators: [
    (Story) => (
      <div style={{ width: '360px' }}>
        <Story />
      </div>
    ),
  ],
};
