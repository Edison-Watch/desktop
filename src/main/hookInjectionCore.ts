/**
 * Core hook script generation helpers.
 * Handles creation and maintenance of the Edison Watch hook scripts on disk.
 */

import { promises as fs, existsSync } from 'fs'
import { homedir, platform } from 'os'
import { join, dirname } from 'path'
import { captureError } from './sentry'

/**
 * Get the path to the Edison Watch pending registrations directory.
 * Hook scripts write JSON files here, and the Electron app watches for new files.
 */
export function getPendingRegistrationsDir(): string {
  return join(homedir(), '.edison-watch', 'pending')
}

/**
 * Get the path to the Edison Watch errors directory.
 * Hook scripts write error JSON here on failure; the Electron app watches and reports to Sentry.
 */
export function getPendingErrorsDir(): string {
  return join(homedir(), '.edison-watch', 'errors')
}

/**
 * Get the path to the Edison Watch hook script.
 * This script is called by the hooks to register the project with Edison Watch.
 */
function getHookScriptPath(): string {
  const scriptName = process.platform === 'win32' ? 'edison-hook.cmd' : 'edison-hook.sh'
  return join(homedir(), '.edison-watch', scriptName)
}

/**
 * Generate the hook script content.
 * This script writes a JSON file to the pending directory instead of making HTTP requests.
 * The Electron app watches this directory and processes new files.
 */
function generateHookScript(): string {
  const pendingDir = getPendingRegistrationsDir()
  const errorsDir = getPendingErrorsDir()

  if (process.platform === 'win32') {
    return `@echo off
REM Edison Watch - Project Registration Hook
REM Writes a registration file for Edison Watch to process

setlocal enabledelayedexpansion

REM Get client name from first argument
set CLIENT=%1
if "%CLIENT%"=="" set CLIENT=unknown

REM Create pending directory if it doesn't exist
if not exist "${pendingDir}" mkdir "${pendingDir}"

REM Generate unique filename using timestamp and random number
set TIMESTAMP=%date:~-4%%date:~4,2%%date:~7,2%-%time:~0,2%%time:~3,2%%time:~6,2%
set TIMESTAMP=%TIMESTAMP: =0%
set FILENAME=%TIMESTAMP%-%RANDOM%-%CLIENT%.json

REM Write registration file
echo {"projectPath": "%CD%", "registeredBy": "%CLIENT%", "timestamp": "%TIMESTAMP%"} > "${pendingDir}\\%FILENAME%"

exit /b 0
`
  }

  return `#!/bin/bash
# Edison Watch - Project Registration Hook
# Writes a registration file for Edison Watch to process

# Get the client that called this hook (passed as first argument)
CLIENT="\${1:-unknown}"

# Pending registrations and errors directories
PENDING_DIR="${pendingDir}"
ERRORS_DIR="${errorsDir}"

# Create directories if they don't exist
mkdir -p "$PENDING_DIR"
mkdir -p "$ERRORS_DIR"

# Generate unique filename
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RANDOM_ID=$RANDOM
FILENAME="\${TIMESTAMP}-\${RANDOM_ID}-\${CLIENT}.json"

# Get current working directory
CWD="$(pwd)"

# Write registration file (atomic via temp file + mv)
TEMP_FILE="$PENDING_DIR/.\${FILENAME}.tmp"
echo "{\\"projectPath\\": \\"$CWD\\", \\"registeredBy\\": \\"$CLIENT\\", \\"timestamp\\": \\"$TIMESTAMP\\"}" > "$TEMP_FILE"
if ! mv "$TEMP_FILE" "$PENDING_DIR/$FILENAME" 2>/dev/null; then
  echo "{\\"error\\":\\"mv failed\\",\\"client\\":\\"$CLIENT\\",\\"timestamp\\":\\"$(date -Iseconds)\\"}" > "$ERRORS_DIR/\${TIMESTAMP}-\${RANDOM_ID}.json"
fi

# Always exit successfully so we don't block the MCP client
exit 0
`
}

/**
 * Ensure the hook script exists and is executable.
 * Also ensures the pending registrations directory exists.
 */
export async function ensureHookScript(): Promise<string> {
  const scriptPath = getHookScriptPath()
  const scriptDir = dirname(scriptPath)
  const pendingDir = getPendingRegistrationsDir()

  try {
    // Ensure directories exist
    if (!existsSync(scriptDir)) {
      await fs.mkdir(scriptDir, { recursive: true })
    }
    if (!existsSync(pendingDir)) {
      await fs.mkdir(pendingDir, { recursive: true })
    }

    // Write the script
    const content = generateHookScript()
    await fs.writeFile(scriptPath, content, { mode: 0o755 })

    console.log(`[HookInjection] Created hook script at ${scriptPath}`)
    return scriptPath
  } catch (err) {
    captureError(err instanceof Error ? err : new Error(String(err)), {
      operation: 'ensureHookScript',
      scriptPath,
      pendingDir,
      platform: platform()
    })
    throw err
  }
}

// ── Session end hook ─────────────────────────────────────────────────────────

/**
 * Get the path to the Edison Watch session end hook script.
 */
function getSessionEndHookScriptPath(): string {
  const scriptName = process.platform === 'win32' ? 'edison-session-end.cmd' : 'edison-session-end.py'
  return join(homedir(), '.edison-watch', scriptName)
}

const SESSION_END_HOOK_PYTHON = `#!/usr/bin/env python3
import json, sys, os, time, random
try:
    data = json.load(sys.stdin)
    conv_id = data.get("conversation_id")
    reason = data.get("reason", "unknown")
    if conv_id:
        pending_dir = os.path.expanduser("~/.edison-watch/pending")
        os.makedirs(pending_dir, exist_ok=True)
        ts = time.strftime("%Y%m%d-%H%M%S")
        fname = f"{ts}-{random.randint(0,99999)}-session-end.json"
        tmp = os.path.join(pending_dir, f".{fname}.tmp")
        final = os.path.join(pending_dir, fname)
        with open(tmp, "w") as f:
            json.dump({"event": "session_end", "conversation_id": conv_id,
                        "reason": reason, "timestamp": ts}, f)
        os.rename(tmp, final)
except Exception:
    pass
sys.exit(0)
`

function generateSessionEndHookScript(): string {
  if (process.platform === 'win32') {
    return `@echo off
REM Edison Watch - Session end hook: write session end event
python "%~dp0edison-session-end.py" 2>nul || python3 "%~dp0edison-session-end.py"
exit /b 0
`
  }
  return SESSION_END_HOOK_PYTHON
}

/**
 * Ensure the session end hook script exists and is executable.
 */
export async function ensureSessionEndHookScript(): Promise<string> {
  const scriptPath = getSessionEndHookScriptPath()
  const scriptDir = dirname(scriptPath)

  try {
    if (!existsSync(scriptDir)) {
      await fs.mkdir(scriptDir, { recursive: true })
    }

    if (process.platform === 'win32') {
      const pyPath = join(scriptDir, 'edison-session-end.py')
      await fs.writeFile(pyPath, SESSION_END_HOOK_PYTHON, 'utf-8')
      await fs.writeFile(scriptPath, generateSessionEndHookScript(), 'utf-8')
    } else {
      await fs.writeFile(scriptPath, generateSessionEndHookScript(), { mode: 0o755 })
    }

    console.log(`[HookInjection] Created session end hook script at ${scriptPath}`)
    return scriptPath
  } catch (err) {
    captureError(err instanceof Error ? err : new Error(String(err)), {
      operation: 'ensureSessionEndHookScript',
      scriptPath,
      platform: platform()
    })
    throw err
  }
}

// ── Session hook (beforeMCPExecution: inject conversation_id) ────────────────

/**
 * Get the path to the Edison Watch session hook script (beforeMCPExecution: inject conversation_id).
 */
function getSessionHookScriptPath(): string {
  const scriptName = process.platform === 'win32' ? 'edison-session-hook.cmd' : 'edison-session-hook.py'
  return join(homedir(), '.edison-watch', scriptName)
}

/** Python script content for the session hook (shared by Unix .py and Windows .py). */
const SESSION_HOOK_PYTHON = `#!/usr/bin/env python3
import json
import sys

try:
    data = json.load(sys.stdin)
    conv_id = data.get("conversation_id")
    tool_input = data.get("tool_input", {})
    if conv_id and isinstance(tool_input, dict):
        tool_input["_edison_conversation_id"] = conv_id
        print(json.dumps({"decision": "allow", "updated_input": tool_input}))
    else:
        print(json.dumps({"decision": "allow"}))
except Exception:
    print(json.dumps({"decision": "allow"}))
sys.exit(0)
`

/**
 * Generate the session hook script content for the current platform.
 * Unix: Python script. Windows: .cmd that invokes the .py in the same directory.
 */
function generateSessionHookScript(): string {
  if (process.platform === 'win32') {
    return `@echo off
REM Edison Watch - Session hook: inject conversation_id into MCP tool args
python "%~dp0edison-session-hook.py" 2>nul || python3 "%~dp0edison-session-hook.py"
exit /b 0
`
  }
  return SESSION_HOOK_PYTHON
}

/**
 * Ensure the session hook script exists and is executable.
 * Unix: writes .py. Windows: writes .py and .cmd (cmd invokes the .py).
 */
export async function ensureSessionHookScript(): Promise<string> {
  const scriptPath = getSessionHookScriptPath()
  const scriptDir = dirname(scriptPath)

  try {
    if (!existsSync(scriptDir)) {
      await fs.mkdir(scriptDir, { recursive: true })
    }

    if (process.platform === 'win32') {
      const pyPath = join(scriptDir, 'edison-session-hook.py')
      await fs.writeFile(pyPath, SESSION_HOOK_PYTHON, 'utf-8')
      await fs.writeFile(scriptPath, generateSessionHookScript(), 'utf-8')
    } else {
      await fs.writeFile(scriptPath, generateSessionHookScript(), { mode: 0o755 })
    }

    console.log(`[HookInjection] Created session hook script at ${scriptPath}`)
    return scriptPath
  } catch (err) {
    captureError(err instanceof Error ? err : new Error(String(err)), {
      operation: 'ensureSessionHookScript',
      scriptPath,
      platform: platform()
    })
    throw err
  }
}
