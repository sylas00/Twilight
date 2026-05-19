@echo off
setlocal

cd /d %~dp0

echo ==========================================
echo    Twilight Backend (Development)
echo ==========================================

if exist ".venv\Scripts\python.exe" (
    set "PYTHON=.venv\Scripts\python.exe"
) else if exist "venv\Scripts\python.exe" (
    set "PYTHON=venv\Scripts\python.exe"
) else (
    set "PYTHON=python"
)

echo Using Python: %PYTHON%
echo Mode: development (main.py api --debug)

if "%TWILIGHT_WITH_SCHEDULER%"=="" set "TWILIGHT_WITH_SCHEDULER=1"
if "%TWILIGHT_SCHEDULER_LOCK_FILE%"=="" set "TWILIGHT_SCHEDULER_LOCK_FILE=%~dp0db\scheduler.lock"
if "%TWILIGHT_WITH_SCHEDULER%"=="1" (
    echo Scheduler: enabled ^(separate window^)
    set "EXISTING_SCHED_PID="
    if exist "%TWILIGHT_SCHEDULER_LOCK_FILE%" (
        for /f "usebackq delims=" %%p in ("%TWILIGHT_SCHEDULER_LOCK_FILE%") do set "EXISTING_SCHED_PID=%%p"
    )
    if not "!EXISTING_SCHED_PID!"=="" (
        powershell -NoProfile -Command "if (Get-Process -Id !EXISTING_SCHED_PID! -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
        if errorlevel 1 set "EXISTING_SCHED_PID="
    )
    if "!EXISTING_SCHED_PID!"=="" (
        start "Twilight Scheduler" cmd /k "cd /d %~dp0 && %PYTHON% main.py scheduler"
    ) else (
        echo Found running Scheduler PID: !EXISTING_SCHED_PID!, skip starting duplicate instance
    )
) else (
    echo Scheduler: disabled ^(set TWILIGHT_WITH_SCHEDULER=1 to enable^)
)

"%PYTHON%" main.py api --debug %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo Backend exited with code %EXIT_CODE%.
    pause
)

exit /b %EXIT_CODE%
