[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("diagnosis", "monitor", "style")]
  [string]$Worker
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$stopFile = Join-Path $repositoryRoot "rpa-runtime\$Worker\stop.request"
$stopDirectory = Split-Path -Parent $stopFile
New-Item -ItemType Directory -Force -Path $stopDirectory | Out-Null
New-Item -ItemType File -Force -Path $stopFile | Out-Null
Write-Host "Drain requested for $Worker. Wait for WORKER_SUMMARY before maintenance."
