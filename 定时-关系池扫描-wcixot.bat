@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
node contacts.js --account wcixot --build >> state\schtask-scan-wcixot.log 2>&1
node contacts.js --account wcixot --scan >> state\schtask-scan-wcixot.log 2>&1
