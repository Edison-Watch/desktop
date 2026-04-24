/**
 * Helpers for fetching organisation-level domain config from the Edison Watch API.
 */

/**
 * Fetch the auto_quarantine_other_mcp_servers flag for the current user's org.
 * Returns false on any error (network, auth, missing config).
 */
export async function fetchAutoQuarantineEnabled(
  apiBaseUrl: string,
  apiKey: string
): Promise<boolean> {
  try {
    const resp = await fetch(`${apiBaseUrl}/api/v1/user/domain-config`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) return false;
    const config = (await resp.json()) as { auto_quarantine_other_mcp_servers?: boolean };
    return !!config.auto_quarantine_other_mcp_servers;
  } catch {
    return false;
  }
}
