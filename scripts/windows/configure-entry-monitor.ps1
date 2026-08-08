[CmdletBinding()]
param(
  [ValidateSet("Test", "ProductionCanary", "Production")]
  [string]$Mode = "Test",

  [string]$ProjectId = "5",

  [string]$RepositoryRoot = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  $RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}
else {
  $RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
}

$envFile = Join-Path $RepositoryRoot ".env"
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
  throw "Missing .env: $envFile"
}

if ($Mode -eq "Test" -and [string]::IsNullOrWhiteSpace($ProjectId)) {
  throw "Test mode requires -ProjectId (default: 5)."
}

if ($Mode -ne "Test") {
  $taskTypeFile = Join-Path $RepositoryRoot "src\rpaTask.ts"
  $workerConfigFile = Join-Path $RepositoryRoot "src\rpaWorkerConfig.ts"
  $supportsAllScope = (Test-Path -LiteralPath $taskTypeFile -PathType Leaf) -and
    (Select-String -LiteralPath $taskTypeFile -Pattern 'EntryMonitorScope\s*=\s*"GRAY"\s*\|\s*"ALL"' -Quiet) -and
    (Test-Path -LiteralPath $workerConfigFile -PathType Leaf) -and
    (Select-String -LiteralPath $workerConfigFile -Pattern 'contentStyleMonitorScope' -Quiet)
  if (-not $supportsAllScope) {
    throw "This crawler version does not support ENTRY/CONTENT_STYLE scope ALL. Deploy the updated source first."
  }
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupFile = "$envFile.$timestamp.bak"
Copy-Item -LiteralPath $envFile -Destination $backupFile

$lines = [System.Collections.Generic.List[string]]::new()
foreach ($line in [System.IO.File]::ReadAllLines($envFile)) {
  $lines.Add($line)
}

function Set-DotEnvValue {
  param(
    [Parameter(Mandatory = $true)][string]$Key,
    [AllowEmptyString()][string]$Value
  )

  $pattern = "^\s*" + [Regex]::Escape($Key) + "\s*="
  $firstIndex = -1
  for ($index = 0; $index -lt $lines.Count; $index++) {
    if ($lines[$index] -match $pattern) {
      if ($firstIndex -eq -1) {
        $firstIndex = $index
        $lines[$index] = "$Key=$Value"
      }
    }
  }

  for ($index = $lines.Count - 1; $index -ge 0; $index--) {
    if ($index -ne $firstIndex -and $lines[$index] -match $pattern) {
      $lines.RemoveAt($index)
    }
  }

  if ($firstIndex -eq -1) {
    $lines.Add("$Key=$Value")
  }
}

$settings = [ordered]@{
  RPA_WORKER_ENVIRONMENT                         = "production"
  RPA_WORKER_ALLOW_PRODUCTION_CLAIMS             = "true"
  RPA_WORKER_PROVIDER_ROUTING_ENABLED             = "true"
  RPA_WORKER_PROVIDER                             = "NEW_RPA"
  RPA_WORKER_GRAY_PERCENTAGE                      = "100"
  RPA_WORKER_RECOVER_STALE                        = "true"
  RPA_MONITOR_DRY_RUN                             = "false"
  RPA_MONITOR_RUN_ONCE                            = "false"
  RPA_MONITOR_CANDIDATE_LIMIT                     = "20"
  RPA_MONITOR_PLATFORMS                           = "doubao,deepseek,qianwen,yuanbao"
  RPA_MONITOR_WEB_SEARCH_POLICY                   = "REQUIRED"
  RPA_MONITOR_POLL_INTERVAL_MS                    = "10000"
  RPA_MONITOR_TASK_INTERVAL_MS                    = "15000"
  RPA_MONITOR_BATCH_INTERVAL_MS                   = "30000"
  RPA_MONITOR_PLATFORM_MIN_INTERVAL_MS            = "15000"
  RPA_STYLE_DRY_RUN                               = "false"
  RPA_STYLE_RUN_ONCE                              = "false"
  RPA_STYLE_CANDIDATE_LIMIT                       = "20"
  RPA_STYLE_PLATFORMS                             = "doubao,deepseek,qianwen,yuanbao"
  RPA_STYLE_WEB_SEARCH_POLICY                     = "REQUIRED"
  RPA_STYLE_POLL_INTERVAL_MS                      = "10000"
  RPA_STYLE_TASK_INTERVAL_MS                      = "15000"
  RPA_STYLE_BATCH_INTERVAL_MS                     = "30000"
  RPA_STYLE_PLATFORM_MIN_INTERVAL_MS              = "15000"
  ENTRY_MONITOR_ENABLED                           = "true"
  ENTRY_MONITOR_CONVERSATION_MAX_QUESTIONS        = "10000"
  ENTRY_MONITOR_CONVERSATION_MAX_DURATION_MS      = "86400000"
  ENTRY_MONITOR_TIMEZONE                          = "Asia/Shanghai"
  CONTENT_STYLE_MONITOR_ENABLED                   = "true"
  CONTENT_STYLE_MONITOR_CONVERSATION_MAX_QUESTIONS = "10000"
  CONTENT_STYLE_MONITOR_CONVERSATION_MAX_DURATION_MS = "86400000"
  CONTENT_STYLE_MONITOR_TIMEZONE                  = "Asia/Shanghai"
  ARTICLE_PROBE_LEGACY_ENABLED                    = "false"
  RPA_WORKER_RUN_ONCE                             = "false"
}

switch ($Mode) {
  "Test" {
    $settings["RPA_MONITOR_MAX_TASKS"] = "1"
    $settings["RPA_STYLE_MAX_TASKS"] = "1"
    $settings["ENTRY_MONITOR_SCOPE"] = "GRAY"
    $settings["ENTRY_MONITOR_GRAY_PROJECT_IDS"] = $ProjectId.Trim()
    $settings["ENTRY_MONITOR_PROJECT_CHUNK_SIZE"] = "1"
    $settings["CONTENT_STYLE_MONITOR_SCOPE"] = "GRAY"
    $settings["CONTENT_STYLE_MONITOR_GRAY_PROJECT_IDS"] = $ProjectId.Trim()
    $settings["CONTENT_STYLE_MONITOR_PROJECT_CHUNK_SIZE"] = "1"
  }
  "ProductionCanary" {
    $settings["RPA_MONITOR_MAX_TASKS"] = "5"
    $settings["RPA_MONITOR_CANDIDATE_LIMIT"] = "100"
    $settings["RPA_STYLE_MAX_TASKS"] = "5"
    $settings["RPA_STYLE_CANDIDATE_LIMIT"] = "100"
    $settings["ENTRY_MONITOR_SCOPE"] = "ALL"
    $settings["ENTRY_MONITOR_GRAY_PROJECT_IDS"] = ""
    $settings["ENTRY_MONITOR_PROJECT_CHUNK_SIZE"] = "5"
    $settings["CONTENT_STYLE_MONITOR_SCOPE"] = "ALL"
    $settings["CONTENT_STYLE_MONITOR_GRAY_PROJECT_IDS"] = ""
    $settings["CONTENT_STYLE_MONITOR_PROJECT_CHUNK_SIZE"] = "5"
  }
  "Production" {
    $settings["RPA_MONITOR_MAX_TASKS"] = "20"
    $settings["RPA_MONITOR_CANDIDATE_LIMIT"] = "100"
    $settings["RPA_STYLE_MAX_TASKS"] = "20"
    $settings["RPA_STYLE_CANDIDATE_LIMIT"] = "100"
    $settings["ENTRY_MONITOR_SCOPE"] = "ALL"
    $settings["ENTRY_MONITOR_GRAY_PROJECT_IDS"] = ""
    $settings["ENTRY_MONITOR_PROJECT_CHUNK_SIZE"] = "5"
    $settings["CONTENT_STYLE_MONITOR_SCOPE"] = "ALL"
    $settings["CONTENT_STYLE_MONITOR_GRAY_PROJECT_IDS"] = ""
    $settings["CONTENT_STYLE_MONITOR_PROJECT_CHUNK_SIZE"] = "5"
  }
}

foreach ($entry in $settings.GetEnumerator()) {
  Set-DotEnvValue -Key $entry.Key -Value ([string]$entry.Value)
}

$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
$content = [string]::Join([Environment]::NewLine, $lines) + [Environment]::NewLine
[System.IO.File]::WriteAllText($envFile, $content, $utf8WithoutBom)

$stopFile = Join-Path $RepositoryRoot "rpa-runtime\monitor\stop.request"
$pauseFile = Join-Path $RepositoryRoot "rpa-runtime\monitor\pause-ENTRY_MONITOR.request"
$styleStopFile = Join-Path $RepositoryRoot "rpa-runtime\style\stop.request"
$stylePauseFile = Join-Path $RepositoryRoot "rpa-runtime\style\pause-CONTENT_STYLE_MONITOR.request"

Write-Host "ENTRY_MONITOR and CONTENT_STYLE_MONITOR configuration updated."
Write-Host "Mode: $Mode"
Write-Host "Scope: $($settings["ENTRY_MONITOR_SCOPE"])"
Write-Host "Project IDs: $($settings["ENTRY_MONITOR_GRAY_PROJECT_IDS"])"
Write-Host "Max tasks per platform per cycle: $($settings["RPA_MONITOR_MAX_TASKS"])"
Write-Host "Style scope: $($settings["CONTENT_STYLE_MONITOR_SCOPE"])"
Write-Host "Style project IDs: $($settings["CONTENT_STYLE_MONITOR_GRAY_PROJECT_IDS"])"
Write-Host "Style max tasks per platform per cycle: $($settings["RPA_STYLE_MAX_TASKS"])"
Write-Host "Backup: $backupFile"
Write-Host "No Worker was started and no database task was claimed."

if (
  (Test-Path -LiteralPath $stopFile) -or
  (Test-Path -LiteralPath $pauseFile) -or
  (Test-Path -LiteralPath $styleStopFile) -or
  (Test-Path -LiteralPath $stylePauseFile)
) {
  Write-Warning "A monitor/style stop or pause request exists. Review and remove it manually before starting Workers."
}

Write-Host "Next: npm.cmd run rpa:monitor:health"
Write-Host "Next: npm.cmd run rpa:style:health"
Write-Host "Then: npm.cmd run rpa:tasks:check -- --worker=monitor --limit=20"
Write-Host "Then: npm.cmd run rpa:tasks:check -- --worker=style --limit=20"
Write-Host "Start only after valid candidates are visible: npm.cmd run rpa:monitor / npm.cmd run rpa:style"
