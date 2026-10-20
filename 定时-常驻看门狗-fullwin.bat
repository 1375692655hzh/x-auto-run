@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
node resident.js --account fullwin --watchdog >> state\resident-fullwin.log 2>&1
