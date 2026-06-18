@echo off
title TPTS Core Dashboard Launcher

:: Force working directory to current folder
cd /d "%~dp0"

echo [1/4] Killing leftover processes...
taskkill /f /im tpts_backend.exe >nul 2>&1

echo [2/4] Starting ADB system daemon...
start /b "" "%~dp0proxy\adb.exe" start-server >nul 2>&1
timeout /t 1 >nul

echo [3/4] Configuring device display (Stay Awake)...
"%~dp0proxy\adb.exe" shell su 0 svc power stayon true >nul 2>&1

echo [4/4] Launching High-Performance Go Server...
start /min "TPTS Core Engine" /d "%~dp0proxy" "%~dp0proxy\tpts_backend.exe"
timeout /t 2 >nul

echo.
echo ===================================================
echo  🚀 TPTS System Connected Successfully!
echo  🌐 Dashboard Link: http://localhost:8080
echo ===================================================
echo.

start "" http://localhost:8080

exit