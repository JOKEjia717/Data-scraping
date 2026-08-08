[CmdletBinding()]
param(
  [ValidateSet("diagnosis", "monitor", "style", "all")]
  [string]$Worker = "all"
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$launcher = Join-Path $PSScriptRoot "run-rpa-worker.ps1"
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$workers = if ($Worker -eq "all") { @("diagnosis", "monitor", "style") } else { @($Worker) }

foreach ($workerName in $workers) {
  $displayName = (Get-Culture).TextInfo.ToTitleCase($workerName)
  $taskName = "Geno RPA $displayName"
  $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`" -Worker $workerName"
  $action = New-ScheduledTaskAction `
    -Execute "$PSHOME\powershell.exe" `
    -Argument $arguments `
    -WorkingDirectory $repositoryRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
  $settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal `
    -UserId $currentUser `
    -LogonType Interactive `
    -RunLevel Limited

  Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Supervises the $workerName RPA worker and restarts it after failures." `
    -Force | Out-Null

  Write-Host "Installed scheduled task: $taskName"
}
