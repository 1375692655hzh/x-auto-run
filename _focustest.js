// 一次性实证：哪类操作会把已开着的比特窗口抬到前台（只读，不碰 X 交互）
// 方法：每种操作前后各读一次 Windows 前台窗口标题，对比变化
const puppeteer = require('puppeteer-core');
const { execSync } = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FG_PS = `Add-Type -AssemblyName System.Runtime.InteropServices; $sig='[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern int GetWindowText(System.IntPtr hWnd, System.Text.StringBuilder text, int count);'; $t=Add-Type -MemberDefinition $sig -Name W32 -PassThru; $b=New-Object System.Text.StringBuilder 512; $h=$t[0]::GetForegroundWindow(); [void]$t[1]::GetWindowText($h,$b,512); $b.ToString()`;
function foreground() {
  try { return execSync(`powershell -NoProfile -Command "${FG_PS.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim(); }
  catch (e) { return 'ERR:' + e.message.slice(0, 40); }
}

const WIN = '60a37618910b4cceaa633a1b9e1089cf'; // fullwin（窗已开着，常驻在跑）
(async () => {
  console.log('基线前台窗口:', foreground());

  // 测试1：对已开的窗重复调 /browser/open
  const j = await fetch('http://127.0.0.1:54345/browser/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: WIN }) }).then((r) => r.json());
  await sleep(1500);
  console.log('① /browser/open 后前台:', foreground());

  // 测试2：newPage 开临时页（常驻每次回复/巡逻/回关的动作）
  const browser = await puppeteer.connect({ browserWSEndpoint: j.data.ws, defaultViewport: null, protocolTimeout: 90000 });
  const pg = await browser.newPage();
  await sleep(1500);
  console.log('② newPage 后前台:', foreground());

  // 测试3：页面跳转
  await pg.goto('about:blank').catch(() => {});
  await sleep(1000);
  console.log('③ goto 后前台:', foreground());

  // 测试4：关闭临时页
  await pg.close().catch(() => {});
  await sleep(1000);
  console.log('④ close 后前台:', foreground());

  await browser.disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
