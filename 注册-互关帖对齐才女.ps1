$ErrorActionPreference = 'Stop'
$root = 'D:\AI X auto\x-boost'
# ① 注册才女 topic-posts 预制任务（对齐 butcher/fullwin 系统，05:50 批量生成九整点互关帖）
$batPath = Join-Path $root '定时-互关帖预制-才女.bat'
$action = New-ScheduledTaskAction -Execute "`"$batPath`""
$trigger = New-ScheduledTaskTrigger -Daily -At '05:50'
Register-ScheduledTask -TaskName 'Xops互关帖预制-才女' -Action $action -Trigger $trigger -Force | Out-Null
Write-Output ("已注册: Xops互关帖预制-才女 05:50 | Exe=" + ((Get-ScheduledTask -TaskName 'Xops互关帖预制-才女').Actions[0].Execute))
# ② 删今早已过点的 5 个旧九槽任务（16/17/19/20 留着跑完今晚，由 20:40 的一次性清理任务收尾）
foreach ($n in @('Xops互关帖-才女-07','Xops互关帖-才女-08','Xops互关帖-才女-10','Xops互关帖-才女-13','Xops互关帖-才女-14')) {
  Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output ("已删旧槽任务: " + $n)
}
