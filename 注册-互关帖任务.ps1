$ErrorActionPreference = 'Stop'
$root = 'D:\AI X auto\x-boost'
$tasks = @(
  @{ Name = 'Xops互关帖-早'; Time = '07:00'; Bat = '定时-互关帖-早.bat' },
  @{ Name = 'Xops互关帖-午'; Time = '13:00'; Bat = '定时-互关帖-午.bat' },
  @{ Name = 'Xops互关帖-晚'; Time = '19:00'; Bat = '定时-互关帖-晚.bat' },
  @{ Name = 'Xops互关帖预制'; Time = '22:45'; Bat = '定时-互关帖预制.bat' }
)
foreach ($t in $tasks) {
  $batPath = Join-Path $root $t.Bat
  $action = New-ScheduledTaskAction -Execute "`"$batPath`""
  $trigger = New-ScheduledTaskTrigger -Daily -At $t.Time
  Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $trigger -Force | Out-Null
  Write-Output ("已注册: " + $t.Name + " @ " + $t.Time + " -> " + $batPath)
}
