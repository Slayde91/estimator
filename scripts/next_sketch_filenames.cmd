@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0next_sketch_filenames.ps1" %*
if errorlevel 1 (
    echo Failed. Read the error above; progress may not have advanced.
) else (
    echo.
    echo Batch prepared. Paste into the attachment picker's File name field.
    echo If no filenames appeared, the queue is finished. Clipboard is unchanged.
    echo Use -Repeat to copy the previous batch again.
)
pause
