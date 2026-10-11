# Avvia llmpod con Docker Compose su Windows. Uso: scripts\start.ps1 [-NoOpenWebUI]
param([switch]$NoOpenWebUI)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function New-RandomHex([int]$Bytes) {
  $buf = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($buf)
  $rng.Dispose()
  -join ($buf | ForEach-Object { $_.ToString('x2') })
}

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

# docker compose sulla cartella del progetto, senza cambiare la cartella corrente.
function Invoke-Compose { docker compose --project-directory $Root -f (Join-Path $Root 'compose.yaml') @args }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { [Console]::Error.WriteLine('Docker non trovato: installa Docker Desktop'); exit 1 }
Invoke-Native { docker info } -Quiet
if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine('Docker non è in esecuzione: avvialo e riprova'); exit 1 }

if (-not $env:LLMPOD_CONFIG_DIR) { $env:LLMPOD_CONFIG_DIR = Join-Path $env:USERPROFILE '.config\llmpod' }
if (-not $env:ZCODE_DIR) { $env:ZCODE_DIR = Join-Path $env:USERPROFILE '.zcode\v2' }
if (-not $env:PI_DIR) { $env:PI_DIR = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE '.pi\agent' } }
foreach ($d in @($env:LLMPOD_CONFIG_DIR, $env:ZCODE_DIR, $env:PI_DIR)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
$envFile = Join-Path $env:LLMPOD_CONFIG_DIR '.env'
if (-not (Test-Path $envFile)) { New-Item -ItemType File -Path $envFile | Out-Null }
$content = Get-Content $envFile -ErrorAction SilentlyContinue
if (-not ($content -match '^LLMPOD_OPENWEBUI_KEY=')) {
  # Se l'ultima riga non termina con un a capo, ne aggiunge uno: la riga precedente resta intatta.
  $bytes = [System.IO.File]::ReadAllBytes($envFile)
  if ($bytes.Length -gt 0 -and $bytes[$bytes.Length - 1] -ne 10) { [System.IO.File]::AppendAllText($envFile, "`n") }
  Add-Content -Path $envFile -Value "LLMPOD_OPENWEBUI_KEY=$(New-RandomHex 32)"
}
$env:LLMPOD_OPENWEBUI_KEY = ((Get-Content $envFile | Where-Object { $_ -match '^LLMPOD_OPENWEBUI_KEY=' } | Select-Object -First 1) -split '=', 2)[1]
$env:LLMPOD_UID = '1000'; $env:LLMPOD_GID = '1000'
# Windows: i file montati nel container appaiono 0777 e chmod non ha effetto (la protezione di .env sono i permessi NTFS del profilo).
$env:LLMPOD_HOST_OS = 'windows'
if (-not $env:LLMPOD_OPENWEBUI_PORT) { $env:LLMPOD_OPENWEBUI_PORT = '3000' }
$env:COMPOSE_PROFILES = if ($NoOpenWebUI) { '' } else { 'openwebui' }
$env:LLMPOD_UI_TOKEN = New-RandomHex 24
$port = if ($env:LLMPOD_UI_PORT) { $env:LLMPOD_UI_PORT } else { '7860' }

# Prima configurazione: manca la chiave Runpod o la configurazione (init interrotto).
$needsInit = (-not ((Get-Content $envFile) -match '^RUNPOD_API_KEY=.')) -or (-not (Test-Path (Join-Path $env:LLMPOD_CONFIG_DIR 'config.json')))
if ($needsInit -and [Console]::IsInputRedirected) {
  [Console]::Error.WriteLine('Prima configurazione: esegui lo script da un terminale interattivo')
  exit 1
}

Invoke-Native { Invoke-Compose build llmpod }
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($needsInit) {
  Write-Host 'Prima configurazione di llmpod…'
  Invoke-Native { Invoke-Compose run --rm -it llmpod init }
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Write-Host 'Avvio dei servizi (Open WebUI al primo avvio può impiegare alcuni minuti)…'
$helpText = (Invoke-Native { Invoke-Compose up --help } 2>&1 | Out-String)
if ($helpText -match '--wait-timeout') {
  Invoke-Native { Invoke-Compose up -d --wait --wait-timeout 120 }
  if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine("⚠ Non tutti i servizi sono ancora pronti (Open WebUI al primo avvio può impiegare alcuni minuti): se serve, controlla con 'bin\llmpod logs'") }
} else {
  Invoke-Native { Invoke-Compose up -d }
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  Invoke-Native { Invoke-Compose exec -T llmpod node -e "fetch('http://127.0.0.1:$port/api/health',{headers:{host:'127.0.0.1:$port'}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" } -Quiet
  if ($LASTEXITCODE -eq 0) { $ok = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $ok) { [Console]::Error.WriteLine("llmpod non risponde: controlla con 'bin\llmpod logs'"); exit 1 }
$url = "http://127.0.0.1:$port/?t=$($env:LLMPOD_UI_TOKEN)"
Write-Host "Interfaccia llmpod: $url"
if (-not $NoOpenWebUI) { Write-Host "Open WebUI: http://127.0.0.1:$($env:LLMPOD_OPENWEBUI_PORT) (il primo account che crei diventa amministratore)" }
Write-Host 'Diagnosi: bin\llmpod logs. Per rientrare nell''interfaccia rilancia questo script (il link con il token cambia a ogni avvio).'
Start-Process $url
