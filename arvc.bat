@echo off
setlocal
rem Windows is a thin dispatcher; the WSL shell script owns all profile logic.
set "PROFILE=%~1"
set "ACTION=%~2"
if /i "%PROFILE%"=="development" set "PROFILE=development"
if /i "%PROFILE%"=="test" set "PROFILE=test"
if /i "%PROFILE%"=="production" set "PROFILE=production"
if /i "%ACTION%"=="start" set "ACTION=start"
if /i "%ACTION%"=="stop" set "ACTION=stop"
if /i "%ACTION%"=="status" set "ACTION=status"
if /i "%ACTION%"=="check" set "ACTION=check"
if "%PROFILE%"=="development" goto check_action
if "%PROFILE%"=="test" goto check_action
if "%PROFILE%"=="production" if "%ACTION%"=="check" goto invoke
:usage
  echo Usage: arvc.bat development start^|stop^|status^|check
  echo        arvc.bat test start^|stop^|status^|check
  echo        arvc.bat production check
  exit /b 2
:check_action
if "%ACTION%"=="start" goto invoke
if "%ACTION%"=="stop" goto invoke
if "%ACTION%"=="status" goto invoke
if "%ACTION%"=="check" goto invoke
goto usage
:invoke
wsl.exe -e bash -lc "repo=$(wslpath -u '%~dp0'); exec \"$repo/scripts/arvc.sh\" %PROFILE% %ACTION%"
exit /b %errorlevel%
