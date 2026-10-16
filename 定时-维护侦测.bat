@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
node maintain-watch.js >> state\schtask-maintain-watch.log 2>&1
