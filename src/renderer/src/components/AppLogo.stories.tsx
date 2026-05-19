import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppLogo } from './AppLogo';

const meta: Meta<typeof AppLogo> = {
  title: 'Client2/AppLogo',
  component: AppLogo,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const ClaudeCode: Story = {
  args: { id: 'claude-code', name: 'Claude Code' },
};

export const Cursor: Story = {
  args: { id: 'cursor', name: 'Cursor' },
};

export const VSCode: Story = {
  args: { id: 'vscode', name: 'Visual Studio Code' },
};

export const Windsurf: Story = {
  args: { id: 'windsurf', name: 'Windsurf' },
};

export const Zed: Story = {
  args: { id: 'zed', name: 'Zed' },
};

export const Codex: Story = {
  args: { id: 'codex', name: 'Codex' },
};

export const UnknownApp: Story = {
  args: { id: 'my-custom-ide', name: 'My Custom IDE' },
};

export const AllLogos: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
      {[
        { id: 'claude-code', name: 'Claude Code' },
        { id: 'cursor', name: 'Cursor' },
        { id: 'vscode', name: 'VS Code' },
        { id: 'windsurf', name: 'Windsurf' },
        { id: 'zed', name: 'Zed' },
        { id: 'intellij', name: 'IntelliJ' },
        { id: 'pycharm', name: 'PyCharm' },
        { id: 'webstorm', name: 'WebStorm' },
        { id: 'codex', name: 'Codex' },
        { id: 'unknown', name: 'Unknown App' },
      ].map(({ id, name }) => (
        <div key={id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem' }}>
          <AppLogo id={id} name={name} />
          <span style={{ fontSize: '0.55rem', color: 'var(--text-muted)', maxWidth: '4rem', textAlign: 'center' }}>{name}</span>
        </div>
      ))}
    </div>
  ),
};
