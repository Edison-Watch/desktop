; Edison Watch uninstall hook: on an interactive uninstall, offer to clear app data
; (always clears the temp log). No-op during silent runs so auto-update keeps data.
!macro customUnInstall
  IfSilent ew_skip

  ; Transient startup log - always remove on a real uninstall.
  Delete "$TEMP\ew-startup.log"

  ; Keep-or-remove prompt (Yes/default = keep). userData folder = package.json
  ; "name"; cover the productName + Local variants. RMDir /r is a no-op if absent.
  MessageBox MB_YESNO|MB_ICONQUESTION "Keep your Edison Watch settings and data for a future reinstall?$\n$\nChoose No to remove them completely." /SD IDYES IDYES ew_skip
  RMDir /r "$APPDATA\edison-watch-client-2"
  RMDir /r "$LOCALAPPDATA\edison-watch-client-2"
  RMDir /r "$APPDATA\Edison Watch"
  RMDir /r "$LOCALAPPDATA\Edison Watch"
  RMDir /r "$PROFILE\.edison-watch"

  ew_skip:
!macroend
