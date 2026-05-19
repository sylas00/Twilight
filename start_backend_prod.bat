@echo off
setlocal EnableDelayedExpansion

cd /d %~dp0

echo ==========================================
echo    Twilight Backend (Production)
echo ==========================================

if exist ".venv\Scripts\python.exe" (
    set "PYTHON=.venv\Scripts\python.exe"
) else if exist "venv\Scripts\python.exe" (
    set "PYTHON=venv\Scripts\python.exe"
) else (
    set "PYTHON=python"
)

if "%TWILIGHT_WITH_BOT%"=="" set "TWILIGHT_WITH_BOT=1"
if "%TWILIGHT_FORCE_RESTART_BOT%"=="" set "TWILIGHT_FORCE_RESTART_BOT=0"
if "%TWILIGHT_BOT_LOCK_FILE%"=="" set "TWILIGHT_BOT_LOCK_FILE=%~dp0db\telegram_bot.lock"
if "%TWILIGHT_WITH_SCHEDULER%"=="" set "TWILIGHT_WITH_SCHEDULER=1"
if "%TWILIGHT_FORCE_RESTART_SCHEDULER%"=="" set "TWILIGHT_FORCE_RESTART_SCHEDULER=0"
if "%TWILIGHT_SCHEDULER_LOCK_FILE%"=="" set "TWILIGHT_SCHEDULER_LOCK_FILE=%~dp0db\scheduler.lock"
if "%TWILIGHT_UVICORN_WORKERS%"=="" set "TWILIGHT_UVICORN_WORKERS=4"

echo Using Python: %PYTHON%
echo Mode: production (uvicorn)
if "%TWILIGHT_WITH_BOT%"=="1" (
    echo Bot: enabled ^(separate window^)
    set "EXISTING_BOT_PID="
    if exist "%TWILIGHT_BOT_LOCK_FILE%" (
        for /f "usebackq delims=" %%p in ("%TWILIGHT_BOT_LOCK_FILE%") do set "EXISTING_BOT_PID=%%p"
        if not "!EXISTING_BOT_PID!"=="" (
            powershell -NoProfile -Command "if (Get-Process -Id !EXISTING_BOT_PID! -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
            if errorlevel 1 (
                echo Found stale Bot lock, cleaning: %TWILIGHT_BOT_LOCK_FILE%
                del /f /q "%TWILIGHT_BOT_LOCK_FILE%" >nul 2>nul
                set "EXISTING_BOT_PID="
            ) else (
                if "%TWILIGHT_FORCE_RESTART_BOT%"=="1" (
                    echo Found running Bot PID: !EXISTING_BOT_PID!, force restarting...
                    taskkill /PID !EXISTING_BOT_PID! /F >nul 2>nul
                    set "EXISTING_BOT_PID="
                ) else (
                    echo Found running Bot PID: !EXISTING_BOT_PID!, skip starting duplicate instance
                )
            )
        )
    )
    if "%TWILIGHT_FORCE_RESTART_BOT%"=="1" (
        start "Twilight Bot" cmd /k "cd /d %~dp0 && %PYTHON% main.py bot"
    ) else (
        if exist "%TWILIGHT_BOT_LOCK_FILE%" (
            for /f "usebackq delims=" %%p in ("%TWILIGHT_BOT_LOCK_FILE%") do set "EXISTING_BOT_PID=%%p"
        )
        if "!EXISTING_BOT_PID!"=="" start "Twilight Bot" cmd /k "cd /d %~dp0 && %PYTHON% main.py bot"
    )
) else (
    echo Bot: disabled ^(set TWILIGHT_WITH_BOT=1 to enable^)
)

if "%TWILIGHT_WITH_SCHEDULER%"=="1" (
    echo Scheduler: enabled ^(separate window^)
    set "EXISTING_SCHED_PID="
    if exist "%TWILIGHT_SCHEDULER_LOCK_FILE%" (
        for /f "usebackq delims=" %%p in ("%TWILIGHT_SCHEDULER_LOCK_FILE%") do set "EXISTING_SCHED_PID=%%p"
        if not "!EXISTING_SCHED_PID!"=="" (
            powershell -NoProfile -Command "if (Get-Process -Id !EXISTING_SCHED_PID! -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
            if errorlevel 1 (
                echo Found stale Scheduler lock, cleaning: %TWILIGHT_SCHEDULER_LOCK_FILE%
                del /f /q "%TWILIGHT_SCHEDULER_LOCK_FILE%" >nul 2>nul
                set "EXISTING_SCHED_PID="
            ) else (
                if "%TWILIGHT_FORCE_RESTART_SCHEDULER%"=="1" (
                    echo Found running Scheduler PID: !EXISTING_SCHED_PID!, force restarting...
                    taskkill /PID !EXISTING_SCHED_PID! /F >nul 2>nul
                    set "EXISTING_SCHED_PID="
                ) else (
                    echo Found running Scheduler PID: !EXISTING_SCHED_PID!, skip starting duplicate instance
                )
            )
        )
    )

    if "%TWILIGHT_FORCE_RESTART_SCHEDULER%"=="1" (
        start "Twilight Scheduler" cmd /k "cd /d %~dp0 && %PYTHON% main.py scheduler"
    ) else (
        if "!EXISTING_SCHED_PID!"=="" start "Twilight Scheduler" cmd /k "cd /d %~dp0 && %PYTHON% main.py scheduler"
    )
) else (
    echo Scheduler: disabled ^(set TWILIGHT_WITH_SCHEDULER=1 to enable^)
)

"%PYTHON%" -m uvicorn asgi:app --host 0.0.0.0 --port 5000 --workers %TWILIGHT_UVICORN_WORKERS% %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo Backend exited with code %EXIT_CODE%.
    pause
)

exit /b %EXIT_CODE%
