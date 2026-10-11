# Ferma llmpod (e Open WebUI) su Windows. Uso: scripts\stop.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (-not $env:LLMPOD_CONFIG_DIR) { $env:LLMPOD_CONFIG_DIR = Join-Path $env:USERPROFILE '.config\llmpod' }
if (-not $env:ZCODE_DIR) { $env:ZCODE_DIR = Join-Path $env:USERPROFILE '.zcode\v2' }
if (-not $env:PI_DIR) { $env:PI_DIR = Join-Path $env:USERPROFILE '.pi\agent' }
$ErrorActionPreference = 'Continue'
docker compose --profile openwebui down
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host 'llmpod fermato (configurazione e dati di Open WebUI conservati)'
