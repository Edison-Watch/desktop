import type { Meta, StoryObj } from '@storybook/react-vite'
import KeyEncryptionAnimation from './KeyEncryptionAnimation'

const meta: Meta<typeof KeyEncryptionAnimation> = {
  title: 'Client2/KeyEncryptionAnimation',
  component: KeyEncryptionAnimation,
  parameters: {
    layout: 'centered'
  }
}

export default meta
type Story = StoryObj<typeof meta>

/** Default 500×216 looping animation. */
export const Default: Story = {
  decorators: [
    (Story) => (
      <div style={{ padding: '24px', background: 'var(--bg-base)' }}>
        <Story />
      </div>
    )
  ]
}
