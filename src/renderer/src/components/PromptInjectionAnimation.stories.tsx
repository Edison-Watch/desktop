import type { Meta, StoryObj } from '@storybook/react-vite'
import PromptInjectionAnimation from './PromptInjectionAnimation'

const meta: Meta<typeof PromptInjectionAnimation> = {
  title: 'Client2/PromptInjectionAnimation',
  component: PromptInjectionAnimation,
  parameters: {
    layout: 'centered'
  }
}

export default meta
type Story = StoryObj<typeof meta>

/** Default 500x190 looping animation. */
export const Default: Story = {
  decorators: [
    (Story) => (
      <div style={{ padding: '24px', background: 'var(--bg-base)' }}>
        <Story />
      </div>
    )
  ]
}
