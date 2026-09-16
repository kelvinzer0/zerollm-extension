@echo off
title ZeroLLM Extension Auto-Updater
cd /d "%~dp0\.."
echo ==========================================
echo ⚡ ZeroLLM Extension Auto-Updater Active
echo 📁 Directory: %CD%
echo ==========================================

:loop
git fetch origin main --quiet 2>nul
for /f %%i in ('git rev-parse HEAD 2^>nul') do set LOCAL_HASH=%%i
for /f %%i in ('git rev-parse origin/main 2^>nul') do set REMOTE_HASH=%%i

if defined LOCAL_HASH if defined REMOTE_HASH if not "%LOCAL_HASH%"=="%REMOTE_HASH%" (
    echo [%date% %time%] 🚀 Update baru ditemukan di GitHub! Memperbarui...
    git pull origin main
    echo [%date% %time%] ✅ Selesai diperbarui! Ekstensi di Chrome akan otomatis menggunakan kode terbaru.
)

timeout /t 60 /nobreak >nul
goto loop
