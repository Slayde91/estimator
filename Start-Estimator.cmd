@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Estimator.ps1" %*
if errorlevel 1 (
    echo.
    echo ESTIMATOR could not start. Read the message above for the next step.
    pause
    exit /b 1
)
endlocal
