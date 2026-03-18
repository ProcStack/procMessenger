@echo off
:: procMessenger - Node.js Server ^& Client Launcher
:: Double-click to launch. Registers in Windows Startup on first run.
:: To remove auto-start, delete the file listed below from your Startup folder.

cd /d "%~dp0"

:: --- Install dependencies if needed ---
if not exist "node_modules" (
    echo [procMessenger] Installing npm dependencies...
    call npm install
    if errorlevel 1 (
        echo [procMessenger] ERROR: npm install failed. Ensure Node.js is installed and on PATH.
        pause
        exit /b 1
    )
    echo.
)

:: --- Launch ---
echo [procMessenger] Starting Node.js client (auto-starts server if needed)...
echo.
node client.js
pause
