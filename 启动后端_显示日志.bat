@echo off
title Storyboard RAG Backend Logs
cd /d "%~dp0"
echo Starting Storyboard RAG backend with visible logs on http://127.0.0.1:8001 ...
echo.
python -u rag_api.py
echo.
echo Backend stopped. Press any key to close this window.
pause >nul
