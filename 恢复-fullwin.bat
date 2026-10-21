@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
del state\PAUSE-fullwin 2>nul
start "" cmd /c "定时-常驻-fullwin.bat"
echo.
echo ===== fullwin 自动化已恢复 =====
echo 旗标已删、常驻进程已拉起（定时任务常驻注册，无需再动）
echo.
pause
