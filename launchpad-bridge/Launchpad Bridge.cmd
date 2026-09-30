@echo off
title Launchpad Bridge
cd /d "%~dp0"

node index.js %*

if errorlevel 1 (
  echo.
  echo Launchpad Bridge stopped with an error. See the messages above.
  pause
)
