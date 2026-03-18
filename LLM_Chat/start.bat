@echo off
:: procMessenger - LLM Chat Client Launcher
:: Double-click to launch. Registers in Windows Startup on first run.
:: To remove auto-start, delete the file listed below from your Startup folder.

cd /d "%~dp0"

:: --- Check for .env configuration ---
if not exist ".env" (
    if exist ".env.example" (
        echo [procMessenger] WARNING: No .env file found.
        echo [procMessenger] Copy .env.example to .env and configure your API keys.
        echo.
    )
)

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
echo [procMessenger] Starting LLM Chat client...
echo.
python llm_client.py
pause
