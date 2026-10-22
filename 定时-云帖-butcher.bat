@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
node cloud-posts.js --account butcher >> state\cloud-posts-butcher.log 2>&1
