@echo off
setlocal
set "APP_DIR=%~dp0"
cd /d "%APP_DIR%"

if not exist "%APP_DIR%node_modules\electron\dist\electron.exe" goto install
if not exist "%APP_DIR%node_modules\systeminformation\package.json" goto install
goto run

:install
where npm >nul 2>nul
if errorlevel 1 goto no_npm
echo Installing dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 goto install_failed

:run
rem Start independently from this command window.
start "System Monitor" /b "%APP_DIR%node_modules\electron\dist\electron.exe" .
exit /b 0

:no_npm
echo npm was not found. Please install Node.js from https://nodejs.org
pause
exit /b 1

:install_failed
echo Dependency installation failed. Keep this window open and check the error above.
pause
exit /b 1
