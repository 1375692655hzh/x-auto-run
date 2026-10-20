@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
node feishu-report.js >> state\feishu-report.log 2>&1
