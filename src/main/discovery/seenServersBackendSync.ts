/**
 * Backend sync for the seen-servers store.
 *
 * Before each quarantine cycle the desktop client must reconcile its local
 * `seen-servers.json` against the org's authoritative list of registered
 * servers, otherwise stale local state can let "registered"/"requested"
 * decisions drift out of sync with reality (e.g. an admin registers a server
 * in the dashboard but a different client running locally has never seen it,
 * so it gets prompted instead of silently quarantined; or the user previously
 * requested a server that the org has since rejected, and the stale "requested"
 * state would silently quarantine a server that is no longer approved).
 *
 * This helper fetches `GET /api/v1/servers/fingerprints`, which returns
 * `{org_id, fingerprints: [{name, fingerprint}]}` (NOT the underlying config -
 * fingerprint computation is server-side per-user, see
 * src/api/v1/routes/servers_fingerprints.py).
 *
 * Security check: the response's `org_id` MUST match the locally-cached
 * `org_id`. A mismatch means either the API key has been re-scoped or the
 * backend returned an unexpected org - in either case we do NOT mutate the
 * seen-store, because silently adopting a different org's server list could
 * auto-quarantine servers the caller has never actually approved.
 *
 * Failure mode: any network/HTTP/mismatch error is silently swallowed and the
 * existing seen-store contents are used as a fallback. Quarantine still runs;
 * the user may just see the prompt for a server they would otherwise have
 * re-quarantined silently. This is the safer fail-mode (no false silent quarantine).
 */

import { getApiBaseUrl, getCredentialsForEnv } from '../infra/setupConfig'
import { getSharedSeenStore } from './seenServersStore'
import { getCachedOrgId, refreshOrgIdFromBackend } from '../infra/orgIdCache'

interface ServerFingerprintResponse {
  name: string
  fingerprint: string
  /** 'registered' = approved template; 'requested' = pending admin review. */
  status: 'registered' | 'requested'
}

interface FingerprintsResponse {
  org_id: string
  fingerprints: ServerFingerprintResponse[]
}

/**
 * Fetch the org's registered server fingerprints from the backend and upsert
 * them into the local seen-store, then prune any locally-tracked entries for
 * the current org that are no longer in the backend's list. Silently no-op on
 * missing credentials, unknown org_id, or network errors.
 */
export async function syncRegisteredServersFromBackend(): Promise<void> {
  const apiBaseUrl = getApiBaseUrl()
  const creds = getCredentialsForEnv()
  if (!apiBaseUrl || !creds?.apiKey) {
    console.log('[SeenServersSync] Skipping - missing apiBaseUrl or apiKey')
    return
  }

  let cachedOrgId = getCachedOrgId()
  if (!cachedOrgId) {
    // Try an inline refresh - the sync is typically triggered during a live
    // user interaction (quarantine popup), so a failed startup refresh
    // shouldn't permanently break it.
    cachedOrgId = await refreshOrgIdFromBackend(apiBaseUrl, creds.apiKey)
  }
  if (!cachedOrgId) {
    console.warn('[SeenServersSync] Skipping - org_id still unknown after refresh attempt')
    return
  }

  const url = `${apiBaseUrl.replace(/\/$/, '')}/api/v1/servers/fingerprints`
  console.log(`[SeenServersSync] GET ${url} org=${cachedOrgId}`)
  // Fingerprinting is server-level (name + url, or name + command + args),
  // not user-level - per-user template values don't feed it. So no
  // X-Edison-Secret-Key is needed.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${creds.apiKey}`,
    Accept: 'application/json',
  }

  let response: Response
  try {
    response = await fetch(url, { method: 'GET', headers })
  } catch (err) {
    console.warn(`[SeenServersSync] Network error fetching fingerprints: ${err}`)
    return
  }

  if (!response.ok) {
    console.warn(`[SeenServersSync] Backend returned ${response.status} - falling back to local seen-store`)
    return
  }

  let payload: FingerprintsResponse
  try {
    payload = (await response.json()) as FingerprintsResponse
  } catch (err) {
    console.log(`[SeenServersSync] Malformed JSON in fingerprints response: ${err}`)
    return
  }

  if (
    !payload ||
    typeof payload.org_id !== 'string' ||
    !payload.org_id ||
    !Array.isArray(payload.fingerprints)
  ) {
    console.log('[SeenServersSync] Unexpected payload shape - skipping')
    return
  }

  // Security check: the response's org_id must match what we have cached.
  // A mismatch means the API key has been re-scoped to a different org (or
  // the backend is misconfigured). Either way, applying the response would
  // taint this org's seen-store with another org's state, so we bail.
  if (payload.org_id !== cachedOrgId) {
    console.warn(
      `[SeenServersSync] org_id mismatch - response=${payload.org_id} cached=${cachedOrgId}. Skipping to avoid cross-org contamination.`,
    )
    return
  }

  // Breakdown of what the backend returned, so log readers can see whether
  // pending requests are coming through (most common bug: requests stored
  // with org_id=NULL won't be in the response even when they should be).
  const registeredCount = payload.fingerprints.filter((f) => f?.status !== 'requested').length
  const requestedCount = payload.fingerprints.filter((f) => f?.status === 'requested').length
  console.log(
    `[SeenServersSync] response org_id=${payload.org_id} entries=${payload.fingerprints.length} (registered=${registeredCount}, requested=${requestedCount})`,
  )
  for (const entry of payload.fingerprints) {
    if (!entry) continue
    console.log(
      `[SeenServersSync]   ${entry.status ?? 'registered'}: name=${entry.name} fp=${entry.fingerprint}`,
    )
  }

  const store = getSharedSeenStore()
  const syncedFingerprints = new Set<string>()
  for (const entry of payload.fingerprints) {
    if (!entry || typeof entry.fingerprint !== 'string' || typeof entry.name !== 'string') {
      continue
    }
    // status is optional for backwards-compat with older backends that only
    // returned approved entries - default to 'registered' in that case.
    const action: 'registered' | 'requested' =
      entry.status === 'requested' ? 'requested' : 'registered'
    syncedFingerprints.add(entry.fingerprint)
    try {
      await store.markFromBackend(cachedOrgId, entry.fingerprint, entry.name, action)
    } catch (err) {
      console.warn(`[SeenServersSync] Failed to upsert ${entry.name}: ${err}`)
    }
  }

  // Prune stale entries for the current org. Entries for other orgs (e.g. a
  // previous login) are intentionally left alone - they remain inert because
  // the quarantine gate requires seen.org_id === current org_id.
  try {
    await store.pruneForOrg(cachedOrgId, syncedFingerprints)
  } catch (err) {
    console.warn(`[SeenServersSync] pruneForOrg failed: ${err}`)
  }

  console.log(
    `[SeenServersSync] done - synced ${payload.fingerprints.length} entries from backend for org ${cachedOrgId}`,
  )
}
