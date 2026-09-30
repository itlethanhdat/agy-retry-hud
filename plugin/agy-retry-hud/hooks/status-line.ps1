$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Payload = [Console]::In.ReadToEnd()
$Entry = Join-Path $Root 'dist/native-entry.js'
if ($Payload.Length -gt 0) {
  $Payload | & node $Entry statusline
} else {
  & node $Entry statusline
}
if ($null -eq $LASTEXITCODE) { exit 0 } else { exit $LASTEXITCODE }
