$ErrorActionPreference = 'Stop'
$root = 'D:\AI X auto\x-boost'
# 10-22 拍板：才女互关帖 3 槽 → 9 整点槽（07/08/10/13/14/16/17/19/20）
foreach ($old in @('Xops互关帖-才女-早', 'Xops互关帖-才女-午', 'Xops互关帖-才女-晚')) {
  Unregister-ScheduledTask -TaskName $old -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output ("已删除旧任务: " + $old)
}
$slots = @(
  @{ Key = 's07'; Time = '07:00' }, @{ Key = 's08'; Time = '08:00' }, @{ Key = 's10'; Time = '10:00' },
  @{ Key = 's13'; Time = '13:00' }, @{ Key = 's14'; Time = '14:00' }, @{ Key = 's16'; Time = '16:00' },
  @{ Key = 's17'; Time = '17:00' }, @{ Key = 's19'; Time = '19:00' }, @{ Key = 's20'; Time = '20:00' }
)
foreach ($s in $slots) {
  $name = 'Xops互关帖-才女-' + $s.Time.Substring(0, 2)
  $batPath = Join-Path $root '定时-互关帖-才女.bat'
  $action = New-ScheduledTaskAction -Execute "`"$batPath`"" -Argument $s.Key
  $trigger = New-ScheduledTaskTrigger -Daily -At $s.Time
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Force | Out-Null
  $next = (Get-ScheduledTask -TaskName $name | Get-ScheduledTaskInfo).NextRunTime
  Write-Output ("已注册: " + $name + " @ " + $s.Time + " → 下次 " + $next)
}
