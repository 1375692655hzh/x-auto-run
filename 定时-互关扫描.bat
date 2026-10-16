@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
node followers-scan.js --jitter-min=90 >> state\schtask-mutual.log 2>&1
