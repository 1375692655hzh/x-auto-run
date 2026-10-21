$ErrorActionPreference = 'Stop'
# 10-21 P1-④：才女被动回复轮询 30→15 分钟提速；才女在人工期——重注册后保持禁用
$batPath = 'C:\xops\inbox-wcixot.bat'
$tr = '"' + $batPath + '"'
& schtasks.exe /Create /TN 'Xops被动回复-才女' /TR $tr /SC MINUTE /MO 15 /ST 07:00 /ET 22:00 /F | Out-Null
Disable-ScheduledTask -TaskName 'Xops被动回复-才女' | Out-Null
$t = Get-ScheduledTask -TaskName 'Xops被动回复-才女'
Write-Output ('已重注册(每15分钟): Exe=' + $t.Actions[0].Execute + ' | State=' + $t.State)
