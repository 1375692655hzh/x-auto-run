@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
node contacts.js --account butcher --liveness --half=2 >> state\schtask-liveness.log 2>&1
