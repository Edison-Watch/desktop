import { useState } from 'react';

type FormState = 'idle' | 'submitting' | 'success';

interface FeedbackFormProps {
  onSubmit?: (message: string) => Promise<void> | void;
  onCancel?: () => void;
  /** Override state for Storybook preview */
  initialState?: FormState;
  /** Pre-fill the textarea for Storybook preview */
  initialMessage?: string;
}

export default function FeedbackForm({
  onSubmit,
  onCancel,
  initialState = 'idle',
  initialMessage = '',
}: FeedbackFormProps): React.ReactNode {
  const [state, setState] = useState<FormState>(initialState);
  const [message, setMessage] = useState(initialMessage);

  async function handleSubmit(): Promise<void> {
    if (!message.trim()) return;
    setState('submitting');
    try {
      await onSubmit?.(message.trim());
      setState('success');
    } catch {
      setState('idle');
    }
  }

  if (state === 'success') {
    return (
      <div style={{ textAlign: 'center', padding: '40px 20px' }}>
        <div style={{ fontSize: 32, color: 'var(--success)', marginBottom: 12 }}>✓</div>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
          Thanks! Your feedback has been sent.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h1
          style={{
            fontSize: 16,
            fontWeight: 600,
            color: 'var(--text-primary)',
            margin: '0 0 6px',
          }}
        >
          Send Feedback
        </h1>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
          Tell us what&apos;s on your mind — bugs, suggestions, or anything else.
        </p>
      </div>

      <div>
        <label
          htmlFor="feedback-message"
          style={{
            display: 'block',
            fontSize: 11,
            fontWeight: 500,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            marginBottom: 6,
          }}
        >
          Message
        </label>
        <textarea
          id="feedback-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={state === 'submitting'}
          placeholder="Describe the issue or share your thoughts..."
          style={{
            width: '100%',
            height: 120,
            background: 'var(--bg-input)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            color: 'var(--text-primary)',
            fontSize: 13,
            padding: '10px 12px',
            resize: 'vertical',
            outline: 'none',
            fontFamily: 'inherit',
            boxSizing: 'border-box',
          }}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          onClick={onCancel}
          disabled={state === 'submitting'}
          style={{
            border: '1px solid var(--border)',
            background: 'transparent',
            color: 'var(--text-secondary)',
            padding: '8px 20px',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 500,
            fontFamily: 'inherit',
          }}
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={state === 'submitting' || !message.trim()}
          style={{
            border: '1px solid var(--accent)',
            background: 'var(--accent)',
            color: '#000',
            padding: '8px 20px',
            borderRadius: 6,
            cursor: state === 'submitting' || !message.trim() ? 'not-allowed' : 'pointer',
            fontSize: 13,
            fontWeight: 600,
            fontFamily: 'inherit',
            opacity: state === 'submitting' || !message.trim() ? 0.5 : 1,
          }}
        >
          {state === 'submitting' ? 'Sending…' : 'Send Feedback'}
        </button>
      </div>
    </div>
  );
}
