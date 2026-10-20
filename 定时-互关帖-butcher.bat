@echo off
cd /d "D:\AI X auto\x-boost"
node mutual-post.js --account butcher --slot %1 >> state\mutual-post.log 2>&1
