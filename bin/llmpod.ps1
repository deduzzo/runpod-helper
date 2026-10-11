# Wrapper della CLI llmpod con Docker su Windows: esegue i comandi nel container, avvia i client sull'host.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

# Esegue un comando nativo senza che lo stderr diventi un errore bloccante
# (PowerShell 5.1 con ErrorActionPreference=Stop); l'esito e' in $LASTEXITCODE.
function Invoke-Native([scriptblock]$Block, [switch]$Quiet) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($Quiet) { & $Block *> $null } else { & $Block }
  } finally {
    $ErrorActionPreference = $prev
  }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { [Console]::Error.WriteLine('Docker non trovato: installa Docker Desktop'); exit 1 }
Invoke-Native { docker info } -Quiet
if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine('Docker non è in esecuzione: avvialo e riprova'); exit 1 }

if (-not $env:LLMPOD_CONFIG_DIR) { $env:LLMPOD_CONFIG_DIR = Join-Path $env:USERPROFILE '.config\llmpod' }
if (-not $env:ZCODE_DIR) { $env:ZCODE_DIR = Join-Path $env:USERPROFILE '.zcode\v2' }
if (-not $env:PI_DIR) { $env:PI_DIR = Join-Path $env:USERPROFILE '.pi\agent' }
foreach ($d in @($env:LLMPOD_CONFIG_DIR, $env:ZCODE_DIR, $env:PI_DIR)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
$env:LLMPOD_UID = '1000'; $env:LLMPOD_GID = '1000'

# Chiave di Open WebUI: letta dal file .env, creata da scripts\start.ps1 (qui serve solo a compose).
$envFile = Join-Path $env:LLMPOD_CONFIG_DIR '.env'
if (Test-Path $envFile) {
  $line = Get-Content $envFile | Where-Object { $_ -match '^LLMPOD_OPENWEBUI_KEY=' } | Select-Object -First 1
  if ($line) { $env:LLMPOD_OPENWEBUI_KEY = ($line -split '=', 2)[1] }
}

$all = @($args)
$client = $null
$rest = $all
if ($all.Count -ge 1 -and $all[0] -eq 'claude') { $client = 'claude'; $rest = @($all | Select-Object -Skip 1) }
elseif ($all.Count -ge 2 -and $all[0] -eq 'run') { $client = $all[1]; $rest = @($all | Select-Object -Skip 2) }

if (-not $client) {
  if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
    Invoke-Native { docker compose run --rm -T llmpod @all }
  } else {
    Invoke-Native { docker compose run --rm -it llmpod @all }
  }
  exit $LASTEXITCODE
}

if ($client -eq 'zcode') {
  if (Get-Process ZCode -ErrorAction SilentlyContinue) {
    [Console]::Error.WriteLine("Chiudi ZCode e riprova: lo riscrive all'uscita e le modifiche andrebbero perse")
    exit 1
  }
  Invoke-Native { docker compose run --rm -T llmpod run zcode --no-open @rest }
  exit $LASTEXITCODE
}

# L'output di prepare contiene la chiave del profilo: non va mai stampato ne' scritto su file, solo valutato.
# Se prepare fallisce si esce con lo stesso codice, senza eseguire nulla.
$script = Invoke-Native { docker compose run --rm -T llmpod prepare $client --format ps1 --host-config-dir $env:LLMPOD_CONFIG_DIR --host-pi-dir $env:PI_DIR @rest }
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Invoke-Expression (@($script) -join "`n")
