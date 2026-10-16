@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
node round.js --account butcher --window pm >> state\round-task.log 2>&1
