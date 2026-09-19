@echo off
rem Double-click this file: it checks for Node, then runs the report generator.
rem
rem * Keep this file ASCII-only and (almost) message-free: every user-facing
rem   line is printed by Node, in Chinese. The single exception is "Node.js not
rem   found" -- Node obviously cannot print that one itself.
rem
rem * This file deliberately does NOT probe for a local proxy port: a wrong guess
rem   silently reroutes the user's traffic and the user never sees it.
rem   People who need an accelerator know they need one and turn it on
rem   themselves. HTTPS_PROXY remains available for unusual setups.

setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on this computer.
  echo   Install it from https://nodejs.org/ ^(LTS is fine^), then run this again.
  echo.
  pause
  exit /b 1
)

node "%~dp0steam-family.js" %*
rem * Keep the exit code: "pause" always returns 0, so capture it first and re-export it.
set "SFC_EXIT=%ERRORLEVEL%"

echo.
pause
exit /b %SFC_EXIT%
