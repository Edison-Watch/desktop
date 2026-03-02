import type { Meta, StoryObj } from '@storybook/react-vite';
import StepIndicator from './StepIndicator';

const meta: Meta<typeof StepIndicator> = {
  title: 'Client2/StepIndicator',
  component: StepIndicator,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Step1Welcome: Story = {
  args: { currentStep: 0 },
};

export const Step2Apps: Story = {
  args: { currentStep: 1 },
};

export const Step3Finish: Story = {
  args: { currentStep: 2 },
};

export const Locked: Story = {
  args: { currentStep: 2, locked: true },
};
