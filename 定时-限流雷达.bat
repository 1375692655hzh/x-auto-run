@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
node radar.js --check >> state\schtask-radar.log 2>&1
