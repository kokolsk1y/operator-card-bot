@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   Bot is starting... DO NOT close this window
echo   Stop: close window or press Ctrl+C
echo ============================================
echo.
node index.mjs
echo.
echo Bot stopped. You can close this window.
pause
