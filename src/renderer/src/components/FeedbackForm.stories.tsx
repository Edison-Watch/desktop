import type { Meta, StoryObj } from '@storybook/react-vite';
import FeedbackForm from './FeedbackForm';

const meta: Meta<typeof FeedbackForm> = {
  title: 'Client2/FeedbackForm',
  component: FeedbackForm,
  parameters: {
    layout: 'centered',
  },
  decorators: [
    (Story) => (
      <div style={{ width: 380, padding: '20px', background: 'var(--bg-raised)', borderRadius: 8 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  args: {
    initialState: 'idle',
    initialMessage: '',
  },
};

export const WithMessage: Story = {
  args: {
    initialState: 'idle',
    initialMessage: 'The hook injection fails silently when Claude Desktop is running. No error shown.',
  },
};

export const Submitting: Story = {
  args: {
    initialState: 'submitting',
    initialMessage: 'The hook injection fails silently when Claude Desktop is running.',
  },
};

export const Success: Story = {
  args: {
    initialState: 'success',
  },
};
