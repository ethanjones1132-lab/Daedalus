@echo off
setlocal
echo [Home Base] Killing old processes...
taskkill /IM "home-base.exe" /F 2>nul
taskkill /IM "cargo.exe" /F 2>nul
timeout /t 2 /nobreak >nul

echo [Home Base] Starting Windows Tauri dev shell...
echo [Home Base] Vite and the Bun backend run in WSL through Tauri hooks.
set "PROJECT_DIR=%~dp0.."

powershell.exe -NoProfile -Command "$env:CARGO_TARGET_DIR = Join-Path $env:USERPROFILE '.cargo-target\home-base'; Set-Location -LiteralPath '%PROJECT_DIR%'; cargo tauri dev"
exit /b %ERRORLEVEL%