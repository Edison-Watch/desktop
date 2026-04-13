/**
 * Backend sync for the seen-servers store.
 *
 * Before each quarantine cycle the desktop client must reconcile its local
 * `seen-servers.json` against the org's authoritative list of registered
 * servers, otherwise stale local state can let "registered" decisions drift
 * out of sync with reality (e.g. an admin registers a server in the dashboard
 * but a different client running locally has never seen it, so it gets
 * prompted instead of silently quarantined).
 *
 * This helper fetches `GET /api/v1/servers/fingerprints`, which returns
 * `[{name, fingerprint}]` pairs (NOT the underlying configuration - fingerprint
 * computation is server-side per-user, see src/api/v1/routes/servers_fingerprints.py)
 * and upserts each entry into the local seen-store with `action: 'registered'`.
 *
 * Failure mode: any network/HTTP error is silently swallowed and the existing
 * seen-store contents are used as a fallback. Quarantine still runs; the user
 * may just see the prompt for a server they would otherwise have re-quarantined
 * silently. This is the safer fail-mode (no false silent quarantine).
 */

import { getApiBaseUrl, getCredentialsForEnv } from './setupConfig'
import { getSharedSeenStore } from './seenServersStore'

interface ServerFingerprintResponse {
  name: string
  fingerprint: string
}

interface FingerprintsResponse {
  fingerprints: ServerFingerprintResponse[]
}

/**
 * Fetch the org's registered server fingerprints from the backend and upsert
 * them into the local seen-store. Silently no-op on missing credentials or
 * network errors.
 */
export async function syncRegisteredServersFromBackend(): Promise<void> {
  const apiBaseUrl = getApiBaseUrl()
  const creds = getCredentialsForEnv()
  if (!apiBaseUrl || !creds?.apiKey) {
    console.log('[SeenServersSync] Skipping - missing apiBaseUrl or apiKey')
    return
  }

  const url = `${apiBaseUrl.replace(/\/$/, '')}/api/v1/servers/fingerprints`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${creds.apiKey}`,
    Accept: 'application/json',
  }
  // The endpoint substitutes templates per-user before computing fingerprints,
  // so it needs the composite secret key to decrypt user-scope template values
  // - same header pattern as mcpServerSubmit.ts and templates.py.
  if (creds.edisonSecretKey) {
    headers['X-Edison-Secret-Key'] = creds.edisonSecretKey
  }

  let response: Response
  try {
    response = await fetch(url, { method: 'GET', headers })
  } catch (err) {
    console.log(`[SeenServersSync] Network error fetching fingerprints: ${err}`)
    return
  }

  if (!response.ok) {
    console.log(`[SeenServersSync] Backend returned ${response.status} - falling back to local seen-store`)
    return
  }

  let payload: FingerprintsResponse
  try {
    payload = (await response.json()) as FingerprintsResponse
  } catch (err) {
    console.log(`[SeenServersSync] Malformed JSON in fingerprints response: ${err}`)
    return
  }

  if (!payload || !Array.isArray(payload.fingerprints)) {
    console.log('[SeenServersSync] Unexpected payload shape - skipping')
    return
  }

  const store = getSharedSeenStore()
  for (const entry of payload.fingerprints) {
    if (!entry || typeof entry.fingerprint !== 'string' || typeof entry.name !== 'string') {
      continue
    }
    try {
      await store.markRegisteredFromBackend(entry.fingerprint, entry.name)
    } catch (err) {
      console.log(`[SeenServersSync] Failed to upsert ${entry.name}: ${err}`)
    }
  }

  console.log(
    `[SeenServersSync] Synced ${payload.fingerprints.length} registered server(s) from backend`,
  )
}
