; YTVDLT NSIS tweaks (0.2.1, D-97).
;
; Why this file exists: `win.icon`, `nsis.installerIcon` and `shortcutName` all
; point at the brand mark, and the built EXE really does embed it (verified by
; comparing the .ico DIB payload against `dist-0.1.10/win-unpacked/YTVDLT.exe`).
; What still goes wrong on a real machine is the *shell*: Windows caches shortcut
; and icon images by path + timestamp, so an in-place upgrade can keep showing
; the previous (Electron "atom") icon on the desktop even though the new exe is
; correct.
;
; `SHChangeNotify(SHCNE_ASSOCCHANGED)` is the documented way to make Explorer
; drop that cache and re-read every icon. It is cheap, needs no elevation and
; cannot fail the install.
;
; Manual recovery on an already-broken machine (no reinstall needed):
;   ie4uinit.exe -show       (rebuild the icon cache)
; or delete the desktop shortcut and let the installer recreate it.

!macro ytvdltRefreshShellIcons
  DetailPrint "刷新 Windows 图标缓存…"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro customInstall
  !insertmacro ytvdltRefreshShellIcons
!macroend

!macro customUnInstall
  ; Uninstall leaves the desktop shortcut deletion to NSIS; still flush the
  ; cache so the now-dangling entry disappears immediately.
  !insertmacro ytvdltRefreshShellIcons
!macroend
