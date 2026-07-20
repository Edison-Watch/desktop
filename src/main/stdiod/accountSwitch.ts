// Keep the daemon bound to the active account on sign-out and account switch.
// config.toml only changes on `login`, so otherwise the daemon stays on the
// previous account.

import { getApiBaseUrl, getCredentialsForEnv } from '../infra/setupConfig'

import { isLaunchAgentLoaded, resetStdiod, uninstall } from './controller'
import { stdiodLog } from './stdiodLog'

// Stop the daemon on sign-out. purge=false keeps config.toml for a quick
// re-enable; unloading the unit is what stops the old tunnel.
export async function teardownStdiodForSignOut(): Promise<void> {
  try {
    await uninstall({ purge: false })
  } catch (err) {
    stdiodLog(`sign-out teardown failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// On account switch: reset an installed daemon onto the new account (keeping
// its device identity), leave it off if it was off, stop it if there are no
// credentials.
export async function reprovisionStdiodForActiveAccount(): Promise<void> {
  // Don't probe launchctl in tests.
  if (process.env.EDISON_DRY_RUN === '1') return

  let installed = false
  try {
    installed = await isLaunchAgentLoaded()
  } catch {
    installed = false
  }
  if (!installed) return

  const backend = getApiBaseUrl()
  const creds = getCredentialsForEnv()
  if (!backend || !creds?.apiKey) {
    stdiodLog('account switch: no credentials for the active account; stopping the daemon')
    await teardownStdiodForSignOut()
    return
  }

  stdiodLog('account switch: re-pointing the daemon at the active account')
  try {
    const result = await resetStdiod({
      backend,
      apiKey: creds.apiKey,
      edisonSecretKey: creds.edisonSecretKey
    })
    if (!result.ok) {
      stdiodLog(
        `account switch: reprovision failed: ${result.errorMessage ?? result.errorCode ?? 'unknown'}`
      )
    }
  } catch (err) {
    stdiodLog(
      `account switch: reprovision threw: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
