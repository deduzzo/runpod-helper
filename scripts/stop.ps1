# Ferma llmpod (e Open WebUI) su Windows. Uso: scripts\stop.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (-not $env:LLMPOD_CONFIG_DIR) { $env:LLMPOD_CONFIG_DIR = Join-Path $env:USERPROFILE '.config\llmpod' }
if (-not $env:ZCODE_DIR) { $env:ZCODE_DIR = Join-Path $env:USERPROFILE '.zcode\v2' }
if (-not $env:PI_DIR) { $env:PI_DIR = Join-Path $env:USERPROFILE '.pi\agent' }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { [Console]::Error.WriteLine('Docker non trovato: installa Docker Desktop'); exit 1 }
# Il comando nativo non deve trasformare lo stderr in errore bloccante (PowerShell 5.1): l'esito e' in $LASTEXITCODE.
$ErrorActionPreference = 'Continue'
docker compose --profile openwebui down
$code = $LASTEXITCODE
if ($code -ne 0) { exit $code }
Write-Host 'llmpod fermato (configurazione e dati di Open WebUI conservati)'
exit 0
