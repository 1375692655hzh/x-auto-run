@echo off
cd /d "D:\AI X auto\x-boost"
echo [%date% %time%] butcher inbox start >> state\inbox-reply.log
node inbox-reply.js --account butcher >> state\inbox-reply.log 2>&1
echo [%date% %time%] butcher inbox exit=%errorlevel% >> state\inbox-reply.log
