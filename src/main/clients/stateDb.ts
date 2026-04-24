/**
 * Shared SQLite utilities for reading/writing IDE state databases (state.vscdb).
 *
 * Both Cursor and VS Code store MCP server state in SQLite databases with the
 * same schema (ItemTable with key/value rows). This module provides the shared
 * query/update primitives; client-specific logic lives in each client's directory.
 */
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'

const SQLITE_TIMEOUT_MS = 5000

/**
 * Read a key's value from a state.vscdb SQLite database.
 * Returns null if the DB doesn't exist or the key isn't found.
 */
export async function queryStateDb(dbPath: string, key: string): Promise<string | null> {
  try {
    await fs.access(dbPath)
  } catch {
    return null
  }

  const safeKey = key.replace(/'/g, "''")
  return new Promise((resolve) => {
    execFile(
      'sqlite3',
      [dbPath, `SELECT value FROM ItemTable WHERE key = '${safeKey}' LIMIT 1;`],
      { timeout: SQLITE_TIMEOUT_MS },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(null)
        } else {
          resolve(stdout.trim())
        }
      }
    )
  })
}

/**
 * Update a key's value in a state.vscdb SQLite database.
 * Writes the new JSON value via a temp file to avoid shell escaping issues.
 */
export async function updateStateDb(dbPath: string, key: string, value: string): Promise<void> {
  try {
    await fs.access(dbPath)
  } catch {
    throw new Error(`State database not found: ${dbPath}`)
  }

  // Write value to temp file to avoid shell escaping issues with large JSON
  const tmpPath = join(dirname(dbPath), `.ew_statedb_tmp_${Date.now()}.txt`)
  try {
    await fs.writeFile(tmpPath, value, 'utf-8')

    const safeKey = key.replace(/'/g, "''")
    // Use readfile() to read the value from the temp file
    const sql = `UPDATE ItemTable SET value = readfile('${tmpPath.replace(/'/g, "''")}') WHERE key = '${safeKey}';`

    await new Promise<void>((resolve, reject) => {
      execFile(
        'sqlite3',
        [dbPath, sql],
        { timeout: SQLITE_TIMEOUT_MS },
        (err) => {
          if (err) reject(new Error(`Failed to update state DB: ${err.message}`))
          else resolve()
        }
      )
    })
  } finally {
    // Clean up temp file
    try { await fs.unlink(tmpPath) } catch { /* ignore */ }
  }
}
