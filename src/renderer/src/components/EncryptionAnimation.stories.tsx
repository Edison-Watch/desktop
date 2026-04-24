import type { Meta, StoryObj } from '@storybook/react-vite'
import EncryptionAnimation from './EncryptionAnimation'

const meta: Meta<typeof EncryptionAnimation> = {
  title: 'Client2/EncryptionAnimation',
  component: EncryptionAnimation,
  parameters: {
    layout: 'centered'
  }
}

export default meta
type Story = StoryObj<typeof meta>

/** Default 240×240 looping animation. */
export const Default: Story = {
  decorators: [
    (Story) => (
      <div style={{ padding: '24px', background: 'var(--bg-base)' }}>
        <Story />
      </div>
    )
  ]
}
