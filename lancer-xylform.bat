@echo off
rem Xylform CAD, by Seb. - lanceur Windows : installe les dependances si besoin puis ouvre le logiciel.
title Xylform CAD, by Seb.
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
echo  Verification des dependances. La premiere fois, cela peut prendre quelques minutes...
call npm.cmd install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo  L'installation a echoue. Verifiez votre connexion Internet puis relancez ce fichier.
  pause
  exit /b 1
)

echo.
echo  Xylform CAD demarre sur http://localhost:5173 - le navigateur va s'ouvrir.
echo  Laissez cette fenetre ouverte pendant votre travail. Fermez-la pour arreter Xylform CAD.
echo.
call npm.cmd run dev
pause
