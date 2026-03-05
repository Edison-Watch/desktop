import * as Sentry from '@sentry/electron/main'
import { app } from 'electron'

const SENTRY_DSN =
  'https://521930844e674e4fe234bf7e2f2a8942@o4509236804190208.ingest.de.sentry.io/4509722815234128'

let SENTRY_ENABLED = false

export function initSentry(): void {
  if (!app.isPackaged) {
    console.log('[Sentry] Disabled in development mode')
    return
  }

  SENTRY_ENABLED = true
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: 'production',
    release: app.getVersion(),
    initialScope: {
      tags: { platform: 'electron' }
    }
  })

  process.on('uncaughtException', (error: Error) => {
    Sentry.captureException(error)
  })
  process.on('unhandledRejection', (reason: unknown) => {
    Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)))
  })

  console.log('[Sentry] Initialized for Electron client')
}

export function captureError(error: unknown, context?: Record<string, unknown>): void {
  if (SENTRY_ENABLED) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { extra: context })
  } else {
    console.error('[sentry] Error captured:', error, context)
  }
}

/**
 * Submit user-provided feedback to Sentry.
 * In dev mode, logs to console instead (Sentry is disabled when unpackaged).
 */
export function submitUserFeedback(comments: string, email?: string): void {
  if (!SENTRY_ENABLED) {
    console.log('[Sentry] User feedback (dev):', comments)
    return
  }
  Sentry.captureFeedback({
    message: comments,
    name: email ?? 'Edison Watch User',
    email: email ?? 'unknown@edisonwatch.app',
  })
}
