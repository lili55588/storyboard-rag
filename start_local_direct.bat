@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"
title Storyboard RAG - Local Direct

rem Keep localhost direct, while still allowing in-app API routes to use
rem the local proxy when their "use proxy" option is enabled with an empty proxy URL.
set "STORYBOARD_PROXY=http://127.0.0.1:10808"
set "HTTP_PROXY=%STORYBOARD_PROXY%"
set "HTTPS_PROXY=%STORYBOARD_PROXY%"
set "ALL_PROXY=%STORYBOARD_PROXY%"
set "http_proxy=%STORYBOARD_PROXY%"
set "https_proxy=%STORYBOARD_PROXY%"
set "all_proxy=%STORYBOARD_PROXY%"
set "NO_PROXY=localhost,127.0.0.1,::1,0.0.0.0"
set "no_proxy=%NO_PROXY%"

echo ==========================================
echo   Starting Storyboard RAG in local-direct mode
echo ==========================================
echo.
echo Antigravity can keep using your global proxy.
echo Local UI/backend bypass proxy via NO_PROXY; external API calls can still use %STORYBOARD_PROXY%.
echo.

for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8001 ^| findstr LISTENING') do (
    echo Port 8001 is already in use. Stopping process %%a ...
    taskkill /PID %%a /F >nul 2>&1
    timeout /t 1 /nobreak >nul
)

echo [1/2] Starting FastAPI backend on http://127.0.0.1:8001 ...
start "Storyboard RAG Backend" cmd /k "cd /d ""%~dp0"" && python -u rag_api.py 1^>backend.local_direct.log 2^>backend.local_direct.err.log"

timeout /t 3 /nobreak >nul

netstat -ano | findstr ":8001" | findstr LISTENING >nul
if errorlevel 1 (
    echo.
    echo Backend did not start on port 8001.
    echo Check: %~dp0backend.local_direct.err.log
    echo.
)

echo [2/2] Starting React frontend on http://localhost:5173 ...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5173 ^| findstr LISTENING') do (
    echo Port 5173 is already in use. Stopping process %%a ...
    taskkill /PID %%a /F >nul 2>&1
    timeout /t 1 /nobreak >nul
)

start "Storyboard RAG UI" cmd /k "cd /d ""%~dp0frontend\storyboard-ui"" && npm run dev -- --host 0.0.0.0 1^>..\..\frontend.local_direct.log 2^>..\..\frontend.local_direct.err.log"

timeout /t 4 /nobreak >nul

netstat -ano | findstr ":5173" | findstr LISTENING >nul
if errorlevel 1 (
    echo.
    echo Frontend did not start on port 5173.
    echo Check: %~dp0frontend.local_direct.err.log
    echo.
) else (
    start http://localhost:5173
)

echo.
echo ==========================================
echo   Started. Keep the two console windows open.
echo ==========================================
echo.
pause
