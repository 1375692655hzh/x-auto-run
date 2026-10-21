@echo off
cd /d "D:\AI X auto\x-boost"
echo [%date% %time%] butcher %1 start >> state\mutual-post.log
node mutual-post.js --account butcher --slot %1 >> state\mutual-post.log 2>&1
echo [%date% %time%] butcher %1 exit=%errorlevel% >> state\mutual-post.log
