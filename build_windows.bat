@echo off
setlocal enabledelayedexpansion

echo ============================================
echo   Meeting Generator - Windows Build
echo ============================================
echo.

set "PROJECT_DIR=%~dp0"
echo Project: %PROJECT_DIR%
echo.

echo [1/4] Checking prerequisites...
python --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Python not found. Install Python 3.10+ from https://python.org
    pause
    exit /b 1
)
python --version

set "NSIS_FOUND=0"
where makensis >nul 2>&1 && set "NSIS_FOUND=1"
if "%NSIS_FOUND%"=="1" (
    echo NSIS: found
) else (
    echo NSIS: not found - installer will be skipped
    echo   To create an installer, install NSIS from https://nsis.sourceforge.io
)

set "SIGNTOOL_FOUND=0"
where signtool >nul 2>&1 && set "SIGNTOOL_FOUND=1"
if defined SIGN_CERT (
    if "%SIGNTOOL_FOUND%"=="1" (
        echo signtool: found; will sign with %SIGN_CERT%
    ) else (
        echo signtool: not found; skipping signing
    )
) else (
    echo SIGN_CERT not set; producing an UNSIGNED build ^(SmartScreen will warn on first run^)
)
echo.

echo [2/4] Building app with PyInstaller...
if not exist "%PROJECT_DIR%.venv_win" (
    python -m venv "%PROJECT_DIR%.venv_win"
)
call "%PROJECT_DIR%.venv_win\Scripts\activate.bat"
python -m pip install --upgrade pip --quiet
pip install -r "%PROJECT_DIR%requirements-windows.txt"

if exist "%PROJECT_DIR%dist" rmdir /s /q "%PROJECT_DIR%dist" 2>nul
if exist "%PROJECT_DIR%build" rmdir /s /q "%PROJECT_DIR%build" 2>nul

pyinstaller --clean --noconfirm "%PROJECT_DIR%app.spec"
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: PyInstaller build failed.
    pause
    exit /b 1
)
echo.

echo [3/4] Optional signing...
if defined SIGN_CERT (
    if "%SIGNTOOL_FOUND%"=="1" (
        echo Signing MeetingGenerator.exe with %SIGN_CERT%
        signtool sign /fd SHA256 /a /f "%SIGN_CERT%" /tr http://timestamp.digicert.com /td SHA256 ^
            "%PROJECT_DIR%dist\MeetingGenerator\MeetingGenerator.exe"
        if %ERRORLEVEL% NEQ 0 (
            echo WARNING: signing failed; continuing with unsigned build.
        )
    )
)
echo.

echo [4/4] Creating installer...

if "%NSIS_FOUND%"=="1" (
    echo Running NSIS...
    makensis "%PROJECT_DIR%installer_windows.nsi"
    if %ERRORLEVEL% NEQ 0 (
        echo WARNING: NSIS installer creation failed.
    ) else (
        if defined SIGN_CERT (
            if "%SIGNTOOL_FOUND%"=="1" (
                echo Signing installer...
                signtool sign /fd SHA256 /a /f "%SIGN_CERT%" /tr http://timestamp.digicert.com /td SHA256 ^
                    "%PROJECT_DIR%dist\MeetingGenerator-Setup.exe"
            )
        )
        echo.
        echo   === INSTALLER created ===
        echo   dist\MeetingGenerator-Setup.exe
        echo.
        echo   Ship this single file. The installer runs per-user (no UAC).
    )
) else (
    echo   NSIS not available. Zipping the app folder instead...
    powershell -Command "Compress-Archive -Path '%PROJECT_DIR%dist\MeetingGenerator\*' -DestinationPath '%PROJECT_DIR%dist\MeetingGenerator-Portable.zip' -Force"
    if exist "%PROJECT_DIR%dist\MeetingGenerator-Portable.zip" (
        echo.
        echo   === ZIP created ===
        echo   dist\MeetingGenerator-Portable.zip
    )
)
echo.

echo === Build complete ===
echo.
echo DISTRIBUTION:
echo   - Installer (.exe):  dist\MeetingGenerator-Setup.exe     [Per-user, no UAC]
echo   - Portable (.zip):   dist\MeetingGenerator-Portable.zip  [If NSIS missing]
echo.
echo For code signing details, see build\signing\windows.md
echo.

pause
