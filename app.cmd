@echo off
rem The clip folder as one window, from anywhere, with no cd.
rem
rem     X:\_CLAUDE\26_09_07_webm-studio\app.cmd
rem
rem Pin it to the taskbar and this is the only thing you ever run. It hands off
rem to electron.exe and exits, so no terminal is left sitting behind the window.
rem Closing the app window ends everything it started, and launching this again
rem focuses the window that is already open rather than starting a second copy.
rem
rem The first run installs Electron, which is a few hundred megabytes and takes
rem a minute. That one run shows its progress here and then this window closes.
setlocal
set "APP=%~dp0"
set "EXE=%APP%node_modules\electron\dist\electron.exe"
if not exist "%EXE%" (
    where npm >nul 2>&1 || (
        echo npm is not on the PATH. Install Node 22 and reopen the shell.
        pause
        exit /b 1
    )
    echo First run, installing Electron. This takes a minute and only happens once.
    pushd "%APP%"
    call npm install || (popd & pause & exit /b 1)
    popd
)
start "" "%EXE%" "%APP%."
endlocal
exit /b 0
