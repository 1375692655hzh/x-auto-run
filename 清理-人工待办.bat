@echo off
chcp 65001 >nul
cd /d "D:\AI X auto\x-boost"
node -e "const fs=require('fs');const f='state/human-todo-fullwin.json';try{const t=JSON.parse(fs.readFileSync(f,'utf8'));const n=(t.pending||[]).filter(x=>x.status==='pending').length;t.pending=(t.pending||[]).map(x=>({...x,status:'done'}));fs.writeFileSync(f,JSON.stringify(t,null,2));console.log('已清除 '+n+' 条待办（全部标 done）');}catch(e){console.log('无待办文件或已空');}"
echo.
echo ===== fullwin 人工待办已清空 =====
pause
