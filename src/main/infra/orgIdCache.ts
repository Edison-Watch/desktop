/**
 * Locally-persisted cache of the authenticated user's org_id (UUID).
 *
 * The desktop client needs to know its own org_id so the seen-servers store
 * can be correctly partitioned per-org - entries written while signed in as
 * org A must not influence silent-quarantine decisions when the user later
 * signs in as org B. We also want quarantine decisions to work when the
 * backend is temporarily offline, so the value is cached to disk.
 *
 * Source of truth: GET /api/v1/user/profile (the `org_id` field).
 * Populated on app startup after auth, and refreshed whenever credentials change.
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { getApiBaseUrl, getCredentialsForEnv } from './setupConfig'

interface OrgIdCacheFile {
  org_id: string
  refreshed_at: number
}

let inMemory: string | null = null
let cachePath: string | null = null
let loaded = false

function getCachePath(): string {
  if (!cachePath) {
    cachePath = join(app.getPath('userData'), 'org-id.json')
  }
  return cachePath
}

/**
 * Load the cached org_id from disk into memory. Idempotent.
 * Called implicitly by getCachedOrgId() on first access.
 */
async function ensureLoaded(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const raw = await fs.readFile(getCachePath(), 'utf-8')
    const parsed = JSON.parse(raw) as OrgIdCacheFile
    if (parsed && typeof parsed.org_id === 'string' && parsed.org_id) {
      inMemory = parsed.org_id
    }
  } catch {
    // Missing or malformed - treated as "not yet known"
    inMemory = null
  }
}

/**
 * Synchronous read of the in-memory cache. Returns null if the cache hasn't
 * been loaded yet OR we've never successfully fetched the org_id.
 *
 * Callers that treat null as "don't know" should fail safe (e.g. never
 * silently quarantine when org_id is unknown).
 */
export function getCachedOrgId(): string | null {
  return inMemory
}

/**
 * Warm the in-memory cache from disk. Call once at app start before any
 * quarantine or seen-store operations.
 */
export async function initOrgIdCache(): Promise<void> {
  await ensureLoaded()
}

/**
 * Combined startup warm-up: load the disk-cached org_id synchronously, then
 * kick off a best-effort backend refresh so the cache is fresh for the
 * quarantine/seen-store flows. Caller does not await the refresh.
 */
export async function warmOrgIdCacheOnStartup(): Promise<void> {
  await initOrgIdCache()
  const apiBaseUrl = getApiBaseUrl()
  const creds = getCredentialsForEnv()
  if (apiBaseUrl && creds?.apiKey) {
    refreshOrgIdFromBackend(apiBaseUrl, creds.apiKey).catch((err) =>
      console.error('[OrgIdCache] Refresh failed:', err),
    )
  }
}

/**
 * Fetch the caller's org_id from the backend and write it to disk + memory.
 * Returns the new org_id on success, or null on network/auth failure
 * (existing cached value is preserved in that case).
 */
export async function refreshOrgIdFromBackend(
  apiBaseUrl: string,
  apiKey: string,
): Promise<string | null> {
  await ensureLoaded()
  if (!apiBaseUrl || !apiKey) {
    console.log('[OrgIdCache] refresh skipped - missing apiBaseUrl or apiKey')
    return inMemory
  }

  const url = `${apiBaseUrl.replace(/\/$/, '')}/api/v1/user/profile`
  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    })
  } catch (err) {
    console.warn(`[OrgIdCache] refresh network error: ${err}`)
    return inMemory
  }

  if (!resp.ok) {
    console.warn(`[OrgIdCache] refresh HTTP ${resp.status} - keeping cached value (${inMemory ?? 'null'})`)
    return inMemory
  }

  let data: { org_id?: string | null }
  try {
    data = (await resp.json()) as { org_id?: string | null }
  } catch (err) {
    console.warn(`[OrgIdCache] refresh: malformed JSON in /user/profile response: ${err}`)
    return inMemory
  }

  const orgId = data.org_id && typeof data.org_id === 'string' ? data.org_id : null
  if (!orgId) {
    console.warn('[OrgIdCache] refresh: /user/profile response did not include org_id')
    return inMemory
  }

  inMemory = orgId
  const payload: OrgIdCacheFile = { org_id: orgId, refreshed_at: Date.now() }
  try {
    await fs.writeFile(getCachePath(), JSON.stringify(payload, null, 2), 'utf-8')
  } catch (err) {
    console.error('[OrgIdCache] Failed to persist org_id:', err)
  }
  console.log(`[OrgIdCache] refreshed org_id=${orgId}`)
  return orgId
}
