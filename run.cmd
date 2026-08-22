@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo [travelplanner] Checking port 6688...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop_existing_port.ps1" -Port 6688 -Root "%~dp0."
if errorlevel 1 (
  echo [travelplanner] Could not safely free port 6688.
  echo [travelplanner] Check the process reported above, then try again.
  exit /b 1
)

if exist runtime\node.exe (
  echo [travelplanner] Starting portable server on http://127.0.0.1:6688/
  runtime\node.exe dist\server\index.js
) else if exist node_modules\.bin\tsx.cmd (
  echo [travelplanner] Starting development server on http://127.0.0.1:6688/
  call npm run dev
) else (
  echo [travelplanner] Starting built server on http://127.0.0.1:6688/
  node dist\server\index.js
)
