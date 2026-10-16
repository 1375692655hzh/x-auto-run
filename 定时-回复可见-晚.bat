@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
node verify-reply.js --window=pm >> state\schtask-verify.log 2>&1
