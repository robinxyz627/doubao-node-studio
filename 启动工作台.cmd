@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$listener=Get-NetTCPConnection -LocalPort 4318 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if($listener){$process=Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue; if($process -and $process.ProcessName -eq 'node'){Stop-Process -Id $process.Id -Force}}"

set "NODE_BIN=node"
where node >NUL 2>NUL
if errorlevel 1 set "NODE_BIN=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_BIN%" (
  echo Node.js was not found. Install Node.js LTS and run this file again.
  pause
  exit /b 1
)

start "Doubao Node Studio" "%NODE_BIN%" "%~dp0server.js"
start "" "http://127.0.0.1:4318"
