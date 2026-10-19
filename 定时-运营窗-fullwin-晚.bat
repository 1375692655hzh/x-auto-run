@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
node round.js --account fullwin --window p3 --modes pull,post >> state\round-fullwin.log 2>&1
