@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
node topic-posts.js --account wcixot >> state\topic-posts-wcixot.log 2>&1
