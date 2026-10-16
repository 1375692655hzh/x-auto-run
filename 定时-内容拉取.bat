@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
set NODE_EXTRA_CA_CERTS=D:\AI X auto\x-boost\x-daily-cert.pem
node content-pull.js >> state\schtask-content-pull.log 2>&1
