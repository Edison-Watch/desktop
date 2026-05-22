// Synchronous cache of the latest StdiodStatus so the tray menu can be
// built without awaiting fs reads on every popup. The cache is refreshed:
//   - on a slow background timer (so the menu reflects external changes
//     like the daemon reconnecting), and
//   - on demand from the tray click handler (so the next popup is fresh).
//
// We don't try to push updates into the tray while it's already open;
// Electron's Tray API rebuilds the menu from a template on each popup,
// so reading a cached snapshot at template-build time is sufficient.

import { getStatus } from './controller'
import type { StdiodStatus } from './types'

let cached: StdiodStatus = {
  binaryAvailable: false,
  installed: false,
  loggedIn: false,
  state: null,
  stateAgeMs: null
}

let refreshTimer: NodeJS.Timeout | null = null

export function getCachedStdiodStatus(): StdiodStatus {
  return cached
}

export async function refreshStdiodStatusCache(): Promise<StdiodStatus> {
  try {
    cached = await getStatus()
  } catch {
    // Best-effort: leave the previous snapshot in place rather than
    // showing a half-zeroed status on a transient fs error.
  }
  return cached
}

export function startStdiodStatusCacheRefresh(intervalMs: number, onUpdate?: () => void): void {
  if (refreshTimer) return
  // Kick an immediate refresh so the cache isn't stale at first popup.
  refreshStdiodStatusCache().then(() => onUpdate?.())
  refreshTimer = setInterval(() => {
    refreshStdiodStatusCache().then(() => onUpdate?.())
  }, intervalMs)
}
