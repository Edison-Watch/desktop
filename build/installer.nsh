!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; Edison Watch uninstall hook. Two independent opt-in prompts (default No = keep).
; No-op on silent runs so auto-update keeps everything. Runs before the app files
; are removed, so the daemon binary is still present for `uninstall --purge`.
!macro customUnInstall
  IfSilent ew_skip

  ; Transient startup log - always removed on a real uninstall.
  Delete "$TEMP\ew-startup.log"

  ; Stop + remove the stdiod daemon (scheduled task + its credentials/logs).
  ; `uninstall --purge` handles the SID-named task (and the legacy name).
  MessageBox MB_YESNO|MB_ICONQUESTION "Stop and remove the Edison stdiod daemon (background tunnel + its saved credentials)?" /SD IDNO IDNO ew_skipDaemon
    nsExec::ExecToLog '"$INSTDIR\resources\bin\edison-stdiod.exe" uninstall --purge'
    RMDir /r "$PROFILE\.config\edison-stdiod"
    RMDir /r "$PROFILE\.local\state\edison-stdiod"
  ew_skipDaemon:

  ; Stop + remove the detector daemon (scheduled task + its enrollment,
  ; seen-store, quarantine records, logs). `service uninstall --purge` handles
  ; the SID-named task (and the legacy name) and wipes its data dir.
  MessageBox MB_YESNO|MB_ICONQUESTION "Stop and remove the Edison detector daemon (background MCP monitor + its quarantine records)?" /SD IDNO IDNO ew_skipDetectord
    nsExec::ExecToLog '"$INSTDIR\resources\bin\edison-detectord.exe" service uninstall --purge'
    RMDir /r "$APPDATA\edison-watch-detectord"
  ew_skipDetectord:

  ; Remove all app data (userData under both name variants + the per-user dir).
  MessageBox MB_YESNO|MB_ICONQUESTION "Remove all Edison Watch data (settings and logs)?" /SD IDNO IDNO ew_skipData
    RMDir /r "$APPDATA\edison-watch-client-2"
    RMDir /r "$LOCALAPPDATA\edison-watch-client-2"
    RMDir /r "$APPDATA\Edison Watch"
    RMDir /r "$LOCALAPPDATA\Edison Watch"
    RMDir /r "$PROFILE\.edison-watch"
  ew_skipData:

  ew_skip:
!macroend
