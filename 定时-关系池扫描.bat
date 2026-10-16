@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
node contacts.js --account butcher --build >> state\schtask-scan.log 2>&1
node contacts.js --account butcher --scan >> state\schtask-scan.log 2>&1
