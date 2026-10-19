@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
node round.js --account maccostin --window p2 --modes pull,community,replyfollowback,post,maintain >> state\round-maccostin.log 2>&1
