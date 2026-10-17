@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
node round.js --account wcixot --window vpm >> state\round-wcixot.log 2>&1
