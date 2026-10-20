@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
echo ===== 半夜数据窗 开始 %date% %time% ===== >> state\night-chain.log
node followers-scan.js --jitter-min=90 >> state\night-chain.log 2>&1
node radar.js --check >> state\night-chain.log 2>&1
node contacts.js --account butcher --build >> state\night-chain.log 2>&1
node contacts.js --account butcher --scan --night >> state\night-chain.log 2>&1
node contacts.js --account wcixot --build >> state\night-chain.log 2>&1
node contacts.js --account wcixot --scan --night >> state\night-chain.log 2>&1
echo ===== 半夜数据窗 结束 %date% %time% ===== >> state\night-chain.log
