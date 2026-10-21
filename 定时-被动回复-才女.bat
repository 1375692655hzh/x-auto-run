@echo off
cd /d "D:\AI X auto\x-boost"
echo [%date% %time%] wcixot inbox start >> state\inbox-reply.log
node inbox-reply.js --account wcixot >> state\inbox-reply.log 2>&1
echo [%date% %time%] wcixot inbox exit=%errorlevel% >> state\inbox-reply.log
