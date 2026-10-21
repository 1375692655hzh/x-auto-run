// resident-guard.js — 共享窗口守卫（10-21 事故根因修复）
// 事故：云帖 executor 收尾无条件 /browser/close，把同窗口常驻进程的三页面打成 detached Frame 僵尸
// （fullwin 僵死 7h，心跳照写、看门狗失明）。守卫规则：该账号有活的常驻（心跳<20min 且 pid 存活）
// 时绝不关窗——窗口是常驻的工位；无常驻账号行为不变（照常关窗防页签累积）。
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

/** 常驻是否在场且健康（心跳新鲜 + pid 活） */
function residentAlive(accountKey) {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', `resident-${accountKey}.json`), 'utf8'));
    if (!st || !st.heartbeatAt) return false;
    if (Date.now() - Date.parse(st.heartbeatAt) > 20 * 60000) return false;
    if (!st.pid || !pidAlive(st.pid)) return false;
    return true;
  } catch { return false; }
}

/** 收尾关窗统一入口：常驻在场→跳过关窗返回 false；否则关窗返回 true */
async function closeWindowIfFree(accountKey, profileId) {
  if (residentAlive(accountKey)) return false;
  await fetch(CFG.bitbrowser + '/browser/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: profileId }) }).catch(() => { });
  return true;
}

module.exports = { residentAlive, closeWindowIfFree, pidAlive };
