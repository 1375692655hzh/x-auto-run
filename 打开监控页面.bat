@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
echo 正在启动 X 运营监控（关闭本窗口即停止服务）...
node dashboard.js
pause
