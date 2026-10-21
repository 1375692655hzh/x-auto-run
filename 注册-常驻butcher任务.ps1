$ErrorActionPreference = 'Stop'
$root = 'D:\AI X auto\x-boost'
# butcher 看齐 fullwin（10-21 拍板）：注册四件套（常驻 00:05 / 看门狗每小时:10 / 云帖每小时:50 / 互关帖预制 05:50）
# 引号纪律：New-ScheduledTaskAction 带引号（schtasks.exe 直传嵌套引号会被 PS 吃掉）
$tasks = @(
  @{ Name = 'Xops常驻-butcher'; Bat = '定时-常驻-butcher.bat'; Daily = '00:05' },
  @{ Name = 'Xops常驻看门狗-butcher'; Bat = '定时-常驻看门狗-butcher.bat'; Hourly = $true },
  @{ Name = 'Xops云帖-butcher'; Bat = '定时-云帖-butcher.bat'; HourlyAt50 = $true },
  @{ Name = 'Xops互关帖预制-butcher'; Bat = '定时-互关帖预制-butcher.bat'; Daily = '05:50' }
)
foreach ($t in $tasks) {
  $batPath = Join-Path $root $t.Bat
  $action = New-ScheduledTaskAction -Execute "`"$batPath`""
  if ($t.Daily) { $trigger = New-ScheduledTaskTrigger -Daily -At $t.Daily }
  elseif ($t.Hourly) { $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date.AddMinutes(((Get-Date).Hour + 1) * 60 + 10)) -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration ([TimeSpan]::FromDays(3650)) }
  else { $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date.AddMinutes(((Get-Date).Hour + 1) * 60 + 50)) -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration ([TimeSpan]::FromDays(3650)) }
  Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $trigger -Force | Out-Null
  $check = (Get-ScheduledTask -TaskName $t.Name).Actions[0]
  $next = (Get-ScheduledTask -TaskName $t.Name | Get-ScheduledTaskInfo).NextRunTime
  Write-Output ("已注册: " + $t.Name + " | Exe=" + $check.Execute + " | Next=" + $next)
}
