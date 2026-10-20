$ErrorActionPreference = 'Stop'
$root = 'D:\AI X auto\x-boost'
# 按账号运行（10-21 拍板）：先拆旧的三槽合并任务
foreach ($old in @('Xops互关帖-早', 'Xops互关帖-午', 'Xops互关帖-晚')) {
  Unregister-ScheduledTask -TaskName $old -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output ("已删除旧任务: " + $old)
}
$tasks = @(
  @{ Name = 'Xops互关帖-butcher-早'; Time = '07:00'; Bat = '定时-互关帖-butcher.bat'; Slot = 'am' },
  @{ Name = 'Xops互关帖-butcher-午'; Time = '13:00'; Bat = '定时-互关帖-butcher.bat'; Slot = 'mid' },
  @{ Name = 'Xops互关帖-butcher-晚'; Time = '19:00'; Bat = '定时-互关帖-butcher.bat'; Slot = 'pm' },
  @{ Name = 'Xops互关帖-才女-早'; Time = '07:00'; Bat = '定时-互关帖-才女.bat'; Slot = 'am' },
  @{ Name = 'Xops互关帖-才女-午'; Time = '13:00'; Bat = '定时-互关帖-才女.bat'; Slot = 'mid' },
  @{ Name = 'Xops互关帖-才女-晚'; Time = '19:00'; Bat = '定时-互关帖-才女.bat'; Slot = 'pm' }
)
foreach ($t in $tasks) {
  $batPath = Join-Path $root $t.Bat
  $action = New-ScheduledTaskAction -Execute "`"$batPath`"" -Argument $t.Slot
  $trigger = New-ScheduledTaskTrigger -Daily -At $t.Time
  Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $trigger -Force | Out-Null
  Write-Output ("已注册: " + $t.Name + " @ " + $t.Time + " -> " + $batPath + " " + $t.Slot)
}
