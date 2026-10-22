$ErrorActionPreference = 'Stop'
# 修复 Xops被动回复-才女：昨日 /SC MINUTE /MO 15 /ET 22:00 注册的触发器 Repetition.Duration 为空=永不重复（事故：10-22 全天 0 轮询）
# 终版=-Once 起点立即 + 每 15 分钟重复 + 3650 天持续（时段控制交给脚本内 07-22 时段门）
$batPath = 'D:\AI X auto\x-boost\定时-被动回复-才女.bat'
$action = New-ScheduledTaskAction -Execute "`"$batPath`""
$trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(2)) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName 'Xops被动回复-才女' -Action $action -Trigger $trigger -Force | Out-Null
$info = Get-ScheduledTask -TaskName 'Xops被动回复-才女' | Get-ScheduledTaskInfo
Write-Output ('已修复: Next=' + $info.NextRunTime + ' | Rep=' + (Get-ScheduledTask -TaskName 'Xops被动回复-才女').Triggers[0].Repetition.Interval + '/' + (Get-ScheduledTask -TaskName 'Xops被动回复-才女').Triggers[0].Repetition.Duration)
