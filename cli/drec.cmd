@echo off
rem drec for the installed app: runs cli\drec.js with the app's own exe acting as Node,
rem so nothing else needs to be installed. The installer adds this folder to the user's PATH.
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\Desktop Recorder.exe" "%~dp0drec.js" %*
exit /b %ERRORLEVEL%
