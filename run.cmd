@echo off
setlocal
cd /d "%~dp0"
if exist runtime\node.exe (
  runtime\node.exe dist\server\index.js
) else (
  node dist\server\index.js
)
