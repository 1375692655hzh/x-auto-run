@echo off
cd /d "D:\AI X auto\x-boost"
echo [%date% %time%] wcixot %1 start >> state\mutual-post.log
node mutual-post.js --account wcixot --slot %1 >> state\mutual-post.log 2>&1
echo [%date% %time%] wcixot %1 exit=%errorlevel% >> state\mutual-post.log
