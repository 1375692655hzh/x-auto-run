@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
node health.js >> state\schtask-health.log 2>&1
