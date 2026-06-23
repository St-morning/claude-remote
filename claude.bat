@echo off
REM Start Feishu server first if not running
powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort 24000 -State Listen -ErrorAction SilentlyContinue)) { Start-Process node -WorkingDirectory 'e:\Todesk_data\claude-remote' -ArgumentList 'server.js' -NoNewWindow }" 2>nul
REM Start Claude Worker if not running (polls Feishu queue, runs Claude in background)
powershell -NoProfile -Command "if (-not (Get-CimInstance Win32_Process -Filter \"CommandLine like '%claude-worker.js%'\" -ErrorAction SilentlyContinue)) { Start-Process node -WorkingDirectory 'e:\Todesk_data\claude-remote' -ArgumentList 'claude-worker.js' -NoNewWindow }" 2>nul
REM Launch Claude CLI
"%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*
