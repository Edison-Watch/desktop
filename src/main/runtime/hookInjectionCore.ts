/**
 * Core hook script generation helpers.
 * Handles creation and maintenance of the Edison Watch hook scripts on disk.
 */

import { promises as fs, existsSync } from 'fs'
import { homedir, platform } from 'os'
import { join, dirname } from 'path'
import { captureError } from '../infra/sentry'
import { getBundledPythonPath } from './pythonBinary'

// Python invocation for a Windows .cmd hook: bundled interpreter by absolute path,
// else PATH (python/python3/py). %~dp0 = the .cmd's dir.
function winPythonInvocation(scriptFileName: string): string {
  const target = `"%~dp0${scriptFileName}"`
  const bundled = getBundledPythonPath()
  if (bundled) {
    return `"${bundled}" ${target}`
  }
  return `python ${target} 2>nul || python3 ${target} 2>nul || py ${target}`
}

/**
 * Get the path to the Edison Watch home directory (~/.edison-watch).
 * Holds the hook scripts, the pending/errors queues, and PID-scoped
 * active_session_<pid>.json files written by the SessionStart hook.
 */
export function getEdisonWatchDir(): string {
  return join(homedir(), '.edison-watch')
}

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

// ── Session start hook ───────────────────────────────────────────────────────

/**
 * Get the path to the Edison Watch session start hook script.
 */
function getSessionStartHookScriptPath(): string {
  const scriptName =
    process.platform === 'win32' ? 'edison-session-start.cmd' : 'edison-session-start.py'
  return join(homedir(), '.edison-watch', scriptName)
}

/** Python script for SessionStart hook.
 *  Reads session_id from Claude Code's SessionStart hook data and persists it
 *  to a PID-scoped file so PreToolUse can read the authoritative session ID. */
const SESSION_START_HOOK_PYTHON = `#!/usr/bin/env python3
import json, sys, os
try:
    data = json.load(sys.stdin)
    session_id = data.get("session_id") or data.get("sessionId")
    # Skip on Windows: .cmd wrapper means PPID is ephemeral cmd.exe, not Claude Code.
    # PreToolUse falls back to hook payload session_id on Windows.
    if session_id and sys.platform != "win32":
        edison_dir = os.path.expanduser("~/.edison-watch")
        os.makedirs(edison_dir, exist_ok=True)
        # PPID = Claude Code process ID. Relies on Claude Code spawning hooks as
        # direct children (execFile/spawn, not sh -c). Falls back gracefully if not.
        ppid = os.getppid()
        fname = f"active_session_{ppid}.json"
        tmp = os.path.join(edison_dir, f".{fname}.tmp")
        final = os.path.join(edison_dir, fname)
        with open(tmp, "w") as f:
            json.dump({"session_id": session_id}, f)
        os.rename(tmp, final)
except Exception:
    pass
sys.exit(0)
`

function generateSessionStartHookScript(): string {
  if (process.platform === 'win32') {
    return `@echo off
REM Edison Watch - Session start hook: persist session_id to PID-scoped file
${winPythonInvocation('edison-session-start.py')}
exit /b 0
`
  }
  return SESSION_START_HOOK_PYTHON
}

/**
 * Ensure the session start hook script exists and is executable.
 */
export async function ensureSessionStartHookScript(): Promise<string> {
  const scriptPath = getSessionStartHookScriptPath()
  const scriptDir = dirname(scriptPath)

  try {
    if (!existsSync(scriptDir)) {
      await fs.mkdir(scriptDir, { recursive: true })
    }

    if (process.platform === 'win32') {
      const pyPath = join(scriptDir, 'edison-session-start.py')
      await fs.writeFile(pyPath, SESSION_START_HOOK_PYTHON, 'utf-8')
      await fs.writeFile(scriptPath, generateSessionStartHookScript(), 'utf-8')
    } else {
      await fs.writeFile(scriptPath, generateSessionStartHookScript(), { mode: 0o755 })
    }

    console.log(`[HookInjection] Created session start hook script at ${scriptPath}`)
    return scriptPath
  } catch (err) {
    captureError(err instanceof Error ? err : new Error(String(err)), {
      operation: 'ensureSessionStartHookScript',
      scriptPath,
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
  const scriptName =
    process.platform === 'win32' ? 'edison-session-end.cmd' : 'edison-session-end.py'
  return join(homedir(), '.edison-watch', scriptName)
}

const SESSION_END_HOOK_PYTHON = `#!/usr/bin/env python3
import json, sys, os, time, random
try:
    data = json.load(sys.stdin)
    conv_id = data.get("session_id") or data.get("conversation_id") or data.get("sessionId")
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
# Clean up PID-scoped active session file - runs regardless of pending-write outcome
# Skip on Windows: .cmd wrapper means PPID is ephemeral cmd.exe, not Claude Code
try:
    if sys.platform != "win32":
        ppid = os.getppid()
        active_file = os.path.expanduser(f"~/.edison-watch/active_session_{ppid}.json")
        if os.path.exists(active_file):
            os.remove(active_file)
except Exception:
    pass
sys.exit(0)
`

function generateSessionEndHookScript(): string {
  if (process.platform === 'win32') {
    return `@echo off
REM Edison Watch - Session end hook: write session end event
${winPythonInvocation('edison-session-end.py')}
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
  const scriptName =
    process.platform === 'win32' ? 'edison-session-hook.cmd' : 'edison-session-hook.py'
  return join(homedir(), '.edison-watch', scriptName)
}

/** Python script content for the session hook (shared by Unix .py and Windows .py).
 *  Format-agnostic: detects VSCode Copilot (hookEventName), Claude Code (hook_event_name), or Cursor (conversation_id).
 *  For Claude Code: reads PID-scoped active session file first (written by SessionStart hook),
 *  falling back to session_id from hook payload data. */
const SESSION_HOOK_PYTHON = `#!/usr/bin/env python3
import json
import sys
import os

try:
    data = json.load(sys.stdin)
    # Detect client: VSCode Copilot (camelCase), Claude Code (snake_case), or Cursor (flat)
    is_vscode = "hookEventName" in data
    is_claude_code = "hook_event_name" in data
    uses_hook_output = is_vscode or is_claude_code
    # Extract conversation/session ID per client format
    if is_vscode:
        conv_id = data.get("sessionId")
    elif is_claude_code:
        # Try PID-scoped active session file first (authoritative, written by SessionStart hook)
        # Skip on Windows: .cmd wrapper gives ephemeral PPID, file won't match
        conv_id = None
        try:
            if sys.platform != "win32":
                ppid = os.getppid()
                active_file = os.path.expanduser(f"~/.edison-watch/active_session_{ppid}.json")
                if os.path.exists(active_file):
                    with open(active_file, "r") as f:
                        active_data = json.load(f)
                    conv_id = active_data.get("session_id")
        except Exception:
            pass
        # Fall back to hook payload data
        if not conv_id:
            conv_id = data.get("session_id") or data.get("conversation_id")
    else:
        conv_id = data.get("conversation_id")
    # Extract tool input (VSCode uses camelCase toolInput)
    tool_input = data.get("toolInput", data.get("tool_input", {})) if is_vscode else data.get("tool_input", {})
    if conv_id and isinstance(tool_input, dict):
        tool_input["_edison_conversation_id"] = conv_id
        if uses_hook_output:
            hook_event = data.get("hookEventName") or data.get("hook_event_name") or "PreToolUse"
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": hook_event,
                "permissionDecision": "allow", "updatedInput": tool_input}}))
        else:
            print(json.dumps({"decision": "allow", "updated_input": tool_input}))
    else:
        if uses_hook_output:
            hook_event = data.get("hookEventName") or data.get("hook_event_name") or "PreToolUse"
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": hook_event,
                "permissionDecision": "allow"}}))
        else:
            print(json.dumps({"decision": "allow"}))
except Exception:
    print(json.dumps({"decision": "allow", "hookSpecificOutput": {
        "hookEventName": "PreToolUse", "permissionDecision": "allow"}}))
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
${winPythonInvocation('edison-session-hook.py')}
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
