@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
node round.js --account maccostin --window p3 --modes pull,community,replyfollowback,post >> state\round-maccostin.log 2>&1
