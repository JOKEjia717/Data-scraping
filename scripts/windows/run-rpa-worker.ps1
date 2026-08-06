[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("diagnosis", "monitor")]
  [string]$Worker
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location -LiteralPath $repositoryRoot

# This local shim only works around uv_os_get_passwd failures in constrained
# Windows sessions. It does not contain credentials.
$nodeUserInfoShim = Join-Path $repositoryRoot ".codex-node-userinfo.cjs"
if (Test-Path -LiteralPath $nodeUserInfoShim) {
  $requireOption = "--require=`"$nodeUserInfoShim`""
  if (-not $env:NODE_OPTIONS) {
    $env:NODE_OPTIONS = $requireOption
  }
  elseif ($env:NODE_OPTIONS -notlike "*$nodeUserInfoShim*") {
    $env:NODE_OPTIONS = "$($env:NODE_OPTIONS) $requireOption"
  }
}

& npm.cmd run "rpa:$Worker"
exit $LASTEXITCODE
