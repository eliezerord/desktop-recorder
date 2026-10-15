; Adds the drec CLI folder to the user's PATH on install and removes it on uninstall.
; The PATH is read and written raw (DoNotExpandEnvironmentNames, ExpandString), so entries such as
; %USERPROFILE%\bin keep their variables; only the one entry for this app is added or removed.
; Setting a throwaway variable afterwards makes Windows tell open programs that the PATH changed.
; In NSIS strings `$$` is a literal `$` for PowerShell, while $INSTDIR is filled in by NSIS.

!macro customInstall
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$d = '$INSTDIR\resources\cli'; $$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); $$p = [string]$$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); $$parts = @($$p.Split(';') | Where-Object { $$_ -ne '' }); if ($$parts -notcontains $$d) { $$k.SetValue('Path', (($$parts + $$d) -join ';'), 'ExpandString'); [Environment]::SetEnvironmentVariable('DesktopRecorderPathRefresh', $$null, 'User') }"`
!macroend

!macro customUnInstall
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$d = '$INSTDIR\resources\cli'; $$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); $$p = [string]$$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); $$parts = @($$p.Split(';') | Where-Object { $$_ -ne '' -and $$_ -ne $$d }); $$k.SetValue('Path', ($$parts -join ';'), 'ExpandString'); [Environment]::SetEnvironmentVariable('DesktopRecorderPathRefresh', $$null, 'User')"`
!macroend
