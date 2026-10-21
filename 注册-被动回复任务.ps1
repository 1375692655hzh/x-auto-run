$ErrorActionPreference = 'Stop'
# 被动回复（10-21 拍板）：每 30 分钟一轮，07:00-22:00。
# 踩坑记录：①& schtasks.exe 传嵌套引号被 PS 吃掉（Exe 截成 D:\AI）②New-ScheduledTaskTrigger -Daily 不支持事后设 Repetition
# 终版=schtasks.exe + C:\xops 无空格 ASCII 包装 bat（/TR 无需嵌套引号，一劳永逸）
$tasks = @(
  @{ Name = 'Xops被动回复-butcher'; Bat = 'C:\xops\inbox-butcher.bat' },
  @{ Name = 'Xops被动回复-才女'; Bat = 'C:\xops\inbox-wcixot.bat' }
)
foreach ($t in $tasks) {
  $tr = '"' + $t.Bat + '"'
  & schtasks.exe /Create /TN $t.Name /TR $tr /SC MINUTE /MO 30 /ST 07:00 /ET 22:00 /F | Out-Null
  $check = (Get-ScheduledTask -TaskName $t.Name).Actions[0]
  Write-Output ("已注册: " + $t.Name + " | Exe=" + $check.Execute)
}
