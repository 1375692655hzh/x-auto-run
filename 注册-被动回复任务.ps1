$ErrorActionPreference = 'Stop'
$root = 'D:\AI X auto\x-boost'
# 被动回复（10-21 拍板）：每 30 分钟一轮，07:00-22:00（接续互关帖早槽评论高峰；脚本内同时段双保险）
$tasks = @(
  @{ Name = 'Xops被动回复-butcher'; Bat = '定时-被动回复-butcher.bat' },
  @{ Name = 'Xops被动回复-才女'; Bat = '定时-被动回复-才女.bat' }
)
foreach ($t in $tasks) {
  $batPath = Join-Path $root $t.Bat
  $tr = '"' + $batPath + '"'
  & schtasks.exe /Create /TN $t.Name /TR $tr /SC MINUTE /MO 30 /ST 07:00 /ET 22:00 /F | Out-Null
  Write-Output ("已注册: " + $t.Name + " 每30分钟 07:00-22:00 -> " + $batPath)
}
