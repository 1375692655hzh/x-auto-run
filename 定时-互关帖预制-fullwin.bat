@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
node topic-posts.js --account fullwin >> state\topic-posts.log 2>&1
