@echo off
:: procMessenger - Node.js Server ^& Client Launcher
:: Double-click to launch. Registers in Windows Startup on first run.
:: To remove auto-start, delete the file listed below from your Startup folder.

cd /d "%~dp0"

set "TASK_NAME=procMessenger-NodeJS"
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "STARTUP_BAT=%STARTUP_DIR%\%TASK_NAME%.bat"

:: --- Register in Windows Startup (runs minimized on logon) ---
if not exist "%STARTUP_BAT%" (
    echo [procMessenger] Registering in Windows Startup...
    (
        echo @echo off
        echo cd /d "%~dp0"
        echo start /min "" node client.js
    ) > "%STARTUP_BAT%"
    echo [procMessenger] Registered. Will auto-start minimized on logon.
    echo [procMessenger] To remove, delete: "%STARTUP_BAT%"
    echo.
) else (
    echo [procMessenger] Already registered in Windows Startup.
    echo.
)

pause
