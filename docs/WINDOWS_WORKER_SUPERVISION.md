# Windows Worker 守护与安全重启

Worker 不需要每天重启。正常做法是让 diagnosis、monitor 各自常驻；只有进程异常退出时由任务计划程序自动拉起，计划维护时先排空再停止。

## 首次安装

先确认 `.env` 中两个 Worker 已配置，Chrome 9222/9223 使用不同 Profile，四个平台均已登录。随后在 PowerShell 中运行：

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\windows\install-rpa-worker-tasks.ps1 -Worker both
Start-ScheduledTask -TaskName "Geno RPA Diagnosis"
Start-ScheduledTask -TaskName "Geno RPA Monitor"
```

任务使用当前交互式 Windows 用户运行。每个角色进程会启动豆包、DeepSeek、千问、元宝四个独立子进程；每个平台独立轮询、独立执行 stale recovery，某个平台退出后默认 5 秒只拉起该平台。角色进程异常退出时，任务计划程序再于一分钟后拉起整个角色。正常排空退出返回 0，不会触发失败重启。

## 计划维护：先排空，禁止直接强杀

请求 diagnosis 安全停止：

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\windows\request-rpa-worker-stop.ps1 -Worker diagnosis
```

请求 monitor 安全停止时把参数改为 `monitor`。Worker 看到 `rpa-runtime/<worker>/stop.request` 后停止领取新批次，正在执行的题先安全收尾；未提交的已领取任务会恢复为 pending，心跳和 advisory lock 最后释放。等待日志出现 `WORKER_SUMMARY` 且进程退出后再维护，不要使用 `Stop-Process -Force`。

恢复运行前删除停止文件，再启动对应任务：

```powershell
Remove-Item -LiteralPath .\rpa-runtime\diagnosis\stop.request
Start-ScheduledTask -TaskName "Geno RPA Diagnosis"
```

## 查看运行状态

```powershell
Get-ScheduledTask -TaskName "Geno RPA *" | Get-ScheduledTaskInfo

Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match "rpaWorkerCli" } |
  Select-Object ProcessId, ParentProcessId, CommandLine

Get-Content .\rpa-runtime\diagnosis\logs\diagnosis-worker-doubao-tasks.jsonl -Tail 30 -Wait
Get-Content .\rpa-runtime\diagnosis\metrics\doubao\worker-metrics.json
```

控制台重点看 `TASK_CLAIMED`、`PLATFORM_AUTO_RECOVERED`、`WORKER_FATAL` 和 `WORKER_SUMMARY`。数据库 SQL、连接池取连接以及 advisory lock 均有硬超时，超时连接会被销毁，不会无限占住连接池。

## 默认保护参数

```env
RPA_DB_CONNECT_TIMEOUT_MS=10000
RPA_DB_ACQUIRE_TIMEOUT_MS=10000
RPA_DB_QUERY_TIMEOUT_MS=15000
RPA_DB_LOCK_QUERY_TIMEOUT_MS=5000
RPA_WORKER_STALE_AFTER_MS=300000
RPA_WORKER_WATCHDOG_STALL_MS=300000
RPA_WORKER_PLATFORM_RECHECK_INTERVAL_MS=60000
RPA_WORKER_PLATFORM_READY_CONFIRMATIONS=2
RPA_WORKER_PLATFORM_PROCESS_RESTART_MS=5000
```

`DOM_CHANGED` 平台每分钟只读复检一次，连续两次 READY 后自动恢复领取。登录失效和验证码仍必须人工处理，不会自动绕过。

同一业务任务、租户和平台只要仍存在无回答的 processing execution，后续 pending 题不会越过它执行。到达 `STALE_AFTER_MS` 后，该平台自己的下一次轮询会先恢复中断题，再领取完整剩余批次；不会等待其他三个平台结束。

从旧版整轮 Worker 首次切换前，必须确认角色根 Outbox 没有 `execution-*.json`。若仍有待回放文件，新版会拒绝启动并提示先运行 `rpa:diagnosis:single` 或 `rpa:monitor:single` 完成安全回放，防止旧结果被平台子目录遗漏。
