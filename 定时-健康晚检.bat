@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
node health.js --light >> state\schtask-health-light.log 2>&1
