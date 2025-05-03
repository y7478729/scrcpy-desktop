@echo off
setlocal EnableDelayedExpansion

:: Set console color (green text on black background)
color 0a

:: Clear screen
cls

:: Display header with improved ASCII art
echo.
echo   [1;33m===============================================[0m
echo       [1;36mscrcpy desktop by serifpersia[0m
echo   [1;33m===============================================[0m
echo     [1;34mhttps://github.com/serifpersia/scrcpy-desktop[0m
echo   [1;33m===============================================[0m
echo.
echo [1;32mStarting scrcpy desktop...[0m
echo.

:: Run npm install
echo [1;33mInstalling dependencies with npm install...[0m
call npm install
if %ERRORLEVEL% neq 0 (
    echo [1;31mError: npm install failed![0m
    pause
    exit /b %ERRORLEVEL%
) else (
    echo [1;32mSuccess: npm install completed![0m
)

:: Run npm run build
echo [1;33mRunning npm run build...[0m
call npm run build
if %ERRORLEVEL% neq 0 (
    echo [1;31mError: npm run build failed![0m
    pause
    exit /b %ERRORLEVEL%
) else (
    echo [1;32mSuccess: npm run build completed![0m
)

:: Run npm start
echo [1;33mRunning npm start...[0m
call npm start
if %ERRORLEVEL% neq 0 (
    echo [1;31mError: npm start failed![0m
    pause
    exit /b %ERRORLEVEL%
) else (
    echo [1;32mSuccess: npm start completed![0m
)

:: Final message
echo.
echo [1;32mAll commands executed successfully![0m
echo [1;33mscrcpy desktop is now running.[0m
pause
exit /b 0