@echo off
:: procMessenger - Python Server ^& Client Launcher
:: Double-click to launch. Registers in Windows Startup on first run.
:: To remove auto-start, delete the file listed below from your Startup folder.

cd /d "%~dp0"

:: --- Install dependencies if needed ---
python -c "import websockets" 2>nul
if errorlevel 1 (
    echo [procMessenger] Installing Python dependencies...
    pip install -r requirements.txt
    if errorlevel 1 (
        echo [procMessenger] ERROR: pip install failed. Ensure Python is installed and on PATH.
        pause
        exit /b 1
    )
    echo.
)

:: --- Launch ---
echo [procMessenger] Starting Python client (auto-starts server if needed)...
echo.
python client.py
pause
