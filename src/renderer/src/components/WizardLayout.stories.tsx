import type { Meta, StoryObj } from '@storybook/react-vite';
import WizardLayout from './WizardLayout';

const meta: Meta<typeof WizardLayout> = {
  title: 'Client2/WizardLayout',
  component: WizardLayout,
  parameters: {
    layout: 'fullscreen',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

const placeholder = (label: string) => (
  <div
    style={{
      padding: '2rem',
      border: '1px dashed var(--border)',
      borderRadius: '0.5rem',
      color: 'var(--text-muted)',
      textAlign: 'center',
      fontSize: '0.875rem',
    }}
  >
    {label}
  </div>
);

export const WelcomeStep: Story = {
  args: {
    currentStep: 0,
    children: placeholder('WelcomeStep content'),
  },
};

export const AppsStep: Story = {
  args: {
    currentStep: 1,
    children: placeholder('AppsStep content'),
  },
};

export const FinishStep: Story = {
  args: {
    currentStep: 2,
    children: placeholder('FinishStep content'),
  },
};

export const LockedFinish: Story = {
  args: {
    currentStep: 2,
    locked: true,
    children: placeholder('Locked finish step'),
  },
};
