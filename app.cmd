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
rem npm can be configured to block install scripts, and Electron's postinstall
rem is the thing that downloads electron.exe. When that is blocked the install
rem reports success and the binary is still missing, so check again rather than
rem handing Windows a path that isn't there.
if not exist "%EXE%" (
    echo.
    echo Electron is installed but its binary is missing.
    echo.
    echo npm blocked the postinstall script that downloads it. Approve it and
    echo fetch the binary with these two, then run this launcher again:
    echo.
    echo     npm --prefix "%APP%." install-scripts approve electron
    echo     npm --prefix "%APP%." rebuild electron
    echo.
    echo ffmpeg-static is blocked the same way. It's optional, and it only
    echo makes the poster frames sharper, so approve it the same way or skip it
    echo and let the app draw its own.
    echo.
    pause
    exit /b 1
)
start "" "%EXE%" "%APP%."
endlocal
exit /b 0
