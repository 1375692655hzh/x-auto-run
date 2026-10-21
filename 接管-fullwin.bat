@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
echo PAUSE-fullwin> state\PAUSE-fullwin
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='cmd.exe'\" | Where-Object { $_.CommandLine -match 'fullwin' -and $_.CommandLine -notmatch 'dashboard' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
curl -s -X POST http://127.0.0.1:54345/browser/close -H "Content-Type: application/json" -d "{\"id\":\"60a37618910b4cceaa633a1b9e1089cf\"}" >nul 2>&1
echo.
echo ===== fullwin 已人工接管 =====
echo 停止：常驻进程已杀、窗口已关、所有调度自动秒退（旗标生效）
echo 操作：比特浏览器手动开 fullwin 窗口即可
echo 恢复自动化：双击 恢复-fullwin.bat
echo.
pause
