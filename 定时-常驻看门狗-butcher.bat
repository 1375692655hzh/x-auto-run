@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
node resident.js --account butcher --watchdog >> state\watchdog-butcher.log 2>&1
