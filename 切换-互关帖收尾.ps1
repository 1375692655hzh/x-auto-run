$ErrorActionPreference = 'Stop'
$root = 'D:\AI X auto\x-boost'
# 一次性收尾（20:40 触发）：今晚 16/17/19/20 旧槽跑完后，删剩余旧任务+旧预制+旧 bat——mutual-post 时代正式关闭
foreach ($n in @('Xops互关帖-才女-16','Xops互关帖-才女-17','Xops互关帖-才女-19','Xops互关帖-才女-20','Xops互关帖预制')) {
  Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output ("已删: " + $n)
}
Remove-Item (Join-Path $root '定时-互关帖-才女.bat') -ErrorAction SilentlyContinue
Remove-Item (Join-Path $root '定时-互关帖预制.bat') -ErrorAction SilentlyContinue
Write-Output '旧互关帖 bat 已删；mutual-post.js 留档（文件头已标退役）'
