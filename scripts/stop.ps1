# Ferma llmpod (e Open WebUI) su Windows. Uso: scripts\stop.ps1
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $env:LLMPOD_CONFIG_DIR) { $env:LLMPOD_CONFIG_DIR = Join-Path $env:USERPROFILE '.config\llmpod' }
if (-not $env:ZCODE_DIR) { $env:ZCODE_DIR = Join-Path $env:USERPROFILE '.zcode\v2' }
if (-not $env:PI_DIR) { $env:PI_DIR = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE '.pi\agent' } }
$env:LLMPOD_UID = '1000'; $env:LLMPOD_GID = '1000'
$env:LLMPOD_HOST_OS = 'windows'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { [Console]::Error.WriteLine('Docker non trovato: installa Docker Desktop'); exit 1 }
# Il comando nativo non deve trasformare lo stderr in errore bloccante (PowerShell 5.1): l'esito e' in $LASTEXITCODE.
$ErrorActionPreference = 'Continue'
# docker compose sulla cartella del progetto, senza cambiare la cartella corrente.
function Invoke-Compose { docker compose --project-directory $Root -f (Join-Path $Root 'compose.yaml') @args }

# Avviso sui Pod ancora esistenti, accesi o spenti (un Pod spento costa ancora il disco). Se il controllo non riesce (nessuna chiave, rete, immagine assente) si prosegue.
$envFile = Join-Path $env:LLMPOD_CONFIG_DIR '.env'
if ((Test-Path $envFile) -and ((Get-Content $envFile) -match '^RUNPOD_API_KEY=.')) {
  docker image inspect llmpod:local *> $null
  if ($LASTEXITCODE -eq 0) {
    $statusJson = (Invoke-Compose run --rm -T llmpod status --json 2>$null | Out-String)
    if ($LASTEXITCODE -eq 0) {
      try {
        foreach ($p in @(($statusJson | ConvertFrom-Json).pods)) {
          if ($p.state -eq 'stopped') {
            [Console]::Error.WriteLine("⚠ Il Pod $($p.podId) del profilo $($p.profile) è spento ma costa ancora lo spazio su disco: eliminalo con bin\llmpod down $($p.profile)")
          } else {
            [Console]::Error.WriteLine("⚠ Il Pod $($p.podId) del profilo $($p.profile) resta acceso e a pagamento: eliminalo con bin\llmpod down $($p.profile)")
          }
        }
      } catch { }
    }
  }
}

Invoke-Compose --profile openwebui down
$code = $LASTEXITCODE
if ($code -ne 0) { exit $code }
Write-Host "llmpod fermato (configurazione e dati di Open WebUI conservati). I Pod su Runpod non vengono toccati: si eliminano con bin\llmpod down o da soli dopo l'inattività"
exit 0
