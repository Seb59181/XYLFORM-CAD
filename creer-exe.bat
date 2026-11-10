@echo off
rem Xylform CAD, by Seb. - genere l'installateur et la version portable Windows (.exe).
title Xylform CAD - creation de l'exe
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js n'est pas installe.
  echo  Telechargez la version LTS sur https://nodejs.org , installez-la, puis relancez ce fichier.
  echo.
  pause
  exit /b 1
)

echo.
echo  1/2 Installation des dependances (la premiere fois : plusieurs minutes, Electron ~ 120 Mo)...
call npm.cmd install --no-audit --no-fund
if errorlevel 1 goto echec

echo.
echo  2/2 Compilation et creation des .exe (2 a 5 minutes)...
call npm.cmd run exe
if errorlevel 1 goto echec

echo.
echo  Termine ! Les fichiers sont dans le dossier "release" :
echo    - Xylform-CAD-Setup-x.y.z.exe   : installateur (raccourcis Bureau et menu Demarrer)
echo    - Xylform-CAD-x.y.z-portable.exe: version portable, sans installation
echo.
start "" "%~dp0release"
pause
exit /b 0

:echec
echo.
echo  La creation de l'exe a echoue. Verifiez votre connexion Internet et le message ci-dessus.
pause
exit /b 1
