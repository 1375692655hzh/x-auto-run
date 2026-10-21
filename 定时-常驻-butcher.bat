@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
node resident.js --account butcher >> state\resident-butcher.log 2>&1
