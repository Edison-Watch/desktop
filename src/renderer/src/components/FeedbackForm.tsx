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
      <div className="text-center py-10 px-5">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400">
          <svg viewBox="0 0 16 16" fill="none" className="h-5 w-5" aria-hidden="true">
            <path d="M3 8l3.5 3.5 6.5-6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <p className="text-sm text-[var(--text-secondary)]">
          Thanks! Your feedback has been sent.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-base font-semibold text-[var(--text-primary)] mb-1.5">
          Send Feedback
        </h1>
        <p className="text-[13px] text-[var(--text-secondary)] leading-relaxed">
          Tell us what&apos;s on your mind - bugs, suggestions, or anything else.
        </p>
      </div>

      <div>
        <label
          htmlFor="feedback-message"
          className="block text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wide mb-1.5"
        >
          Message
        </label>
        <textarea
          id="feedback-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={state === 'submitting'}
          placeholder="Describe the issue or share your thoughts..."
          className="w-full h-[120px] bg-[var(--bg-input)] border border-[var(--border)] rounded-md text-[var(--text-primary)] text-[13px] px-3 py-2.5 resize-y outline-none font-[inherit] focus:ring-2 focus:ring-[var(--accent)] focus:border-transparent transition-colors placeholder:text-[var(--text-muted)]"
        />
      </div>

      <div className="flex gap-2 justify-end">
        <button
          onClick={onCancel}
          disabled={state === 'submitting'}
          className="border border-[var(--border)] bg-transparent text-[var(--text-secondary)] px-5 py-2 rounded-md cursor-pointer text-[13px] font-medium font-[inherit] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={state === 'submitting' || !message.trim()}
          className="border border-[var(--accent)] bg-[var(--accent)] text-[var(--bg-base)] px-5 py-2 rounded-md text-[13px] font-semibold font-[inherit] hover:brightness-110 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {state === 'submitting' ? 'Sending…' : 'Send Feedback'}
        </button>
      </div>
    </div>
  );
}
