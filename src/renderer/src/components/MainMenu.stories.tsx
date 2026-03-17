import type { Meta, StoryObj } from '@storybook/react-vite';
import MainMenu from './MainMenu';

const meta: Meta = {
  title: 'Client2/MainMenu',
  parameters: {
    layout: 'fullscreen',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

const SETUP_DATA = {
  completed: true,
  userEmail: 'alice@example.com',
  mcpBaseUrl: 'https://mcp.demo.example.com',
  apiBaseUrl: 'https://api.demo.example.com',
  apiKey: 'edison_demo_apikey_abc123',
};

/** Connected to the Edison Watch server. */
export const Connected: Story = {
  decorators: [
    (Story) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (window as any).api;
      api.setup.getData = async () => SETUP_DATA;
      api.health.check = async () => true;
      api.menu.getVersion = async () => '2.1.0';
      api.menu.resizeWindow = async () => {};
      api.config.getEffectiveBaseUrls = async () => ({
        mcpBaseUrl: SETUP_DATA.mcpBaseUrl,
        apiBaseUrl: SETUP_DATA.apiBaseUrl,
      });
      return <Story />;
    },
  ],
  render: () => <MainMenu />,
};

/** Server is currently unreachable. */
export const Disconnected: Story = {
  decorators: [
    (Story) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (window as any).api;
      api.setup.getData = async () => SETUP_DATA;
      api.health.check = async () => false;
      api.menu.getVersion = async () => '2.1.0';
      api.menu.resizeWindow = async () => {};
      api.config.getEffectiveBaseUrls = async () => ({
        mcpBaseUrl: SETUP_DATA.mcpBaseUrl,
        apiBaseUrl: SETUP_DATA.apiBaseUrl,
      });
      return <Story />;
    },
  ],
  render: () => <MainMenu />,
};

/** Initial load — setup data not yet available. */
export const Loading: Story = {
  decorators: [
    (Story) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (window as any).api;
      // Never resolves → stays in loading state for screenshot
      api.setup.getData = () => new Promise(() => {});
      return <Story />;
    },
  ],
  render: () => <MainMenu />,
};
