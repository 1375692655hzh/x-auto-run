@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
node content-pull.js >> state\schtask-content-pull.log 2>&1
