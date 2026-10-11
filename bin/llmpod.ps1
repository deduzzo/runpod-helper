# Wrapper della CLI llmpod con Docker su Windows: esegue i comandi nel container, avvia i client sull'host.
# Non cambia la cartella corrente (i client partono da dove lanci il comando) e lascia la sessione com'era.
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

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

# Variabili d'ambiente di processo: si salvano i valori originali e si ripristinano all'uscita
# (quelle che non esistevano vengono rimosse), cosi' la sessione dell'utente resta com'era.
$script:SavedEnv = @{}
function Save-Env([string[]]$Names) {
  foreach ($n in $Names) {
    if (-not $script:SavedEnv.ContainsKey($n)) { $script:SavedEnv[$n] = [Environment]::GetEnvironmentVariable($n, 'Process') }
  }
}
function Restore-Env {
  foreach ($n in @($script:SavedEnv.Keys)) {
    $orig = $script:SavedEnv[$n]
    if ($null -eq $orig) { Remove-Item -LiteralPath "Env:$n" -ErrorAction SilentlyContinue }
    else { Set-Item -LiteralPath "Env:$n" -Value $orig }
  }
}

# L'esito va in $script:Rc (non si restituisce nulla: l'output dei comandi nativi deve restare sulla console).
function Invoke-Llmpod([string[]]$CliArgs) {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { [Console]::Error.WriteLine('Docker non trovato: installa Docker Desktop'); $script:Rc = 1; return }
  Invoke-Native { docker info } -Quiet
  if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine('Docker non è in esecuzione: avvialo e riprova'); $script:Rc = 1; return }

  Save-Env @('LLMPOD_CONFIG_DIR', 'ZCODE_DIR', 'PI_DIR', 'LLMPOD_UID', 'LLMPOD_GID', 'LLMPOD_HOST_OS', 'LLMPOD_OPENWEBUI_KEY', 'LLMPOD_OPENWEBUI_PORT')
  if (-not $env:LLMPOD_CONFIG_DIR) { $env:LLMPOD_CONFIG_DIR = Join-Path $env:USERPROFILE '.config\llmpod' }
  if (-not $env:ZCODE_DIR) { $env:ZCODE_DIR = Join-Path $env:USERPROFILE '.zcode\v2' }
  if (-not $env:PI_DIR) { $env:PI_DIR = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE '.pi\agent' } }
  foreach ($d in @($env:LLMPOD_CONFIG_DIR, $env:ZCODE_DIR, $env:PI_DIR)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
  $env:LLMPOD_UID = '1000'; $env:LLMPOD_GID = '1000'
  # Windows: i file montati nel container appaiono 0777 e chmod non ha effetto (la protezione di .env sono i permessi NTFS del profilo).
  $env:LLMPOD_HOST_OS = 'windows'
  if (-not $env:LLMPOD_OPENWEBUI_PORT) { $env:LLMPOD_OPENWEBUI_PORT = '3000' }

  # Chiave di Open WebUI: letta dal file .env, creata da scripts\start.ps1 (qui serve solo a compose).
  $envFile = Join-Path $env:LLMPOD_CONFIG_DIR '.env'
  if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match '^LLMPOD_OPENWEBUI_KEY=' } | Select-Object -First 1
    if ($line) { $env:LLMPOD_OPENWEBUI_KEY = ($line -split '=', 2)[1] }
  }

  $all = @($CliArgs)
  $first = if ($all.Count -ge 1) { $all[0] } else { '' }

  # Comandi gestiti dal wrapper, senza passare dal container.
  if ($first -eq 'ui') {
    [Console]::Error.WriteLine("Nel setup Docker l'interfaccia la avvia scripts/start")
    $script:Rc = 1; return
  }
  if ($first -eq 'chat') {
    # Host diverso da 127.0.0.1 (quello della UI): il cookie di sessione della UI non viene inviato a Open WebUI.
    $chatUrl = "http://localhost:$($env:LLMPOD_OPENWEBUI_PORT)"
    Write-Host "Open WebUI: $chatUrl"
    try { Start-Process $chatUrl } catch { }
    $script:Rc = 0; return
  }
  if ($first -eq 'logs') {
    # Diagnosi: ultimi log del servizio (predefinito llmpod), seguiti. Nei log c'e' anche il link dell'interfaccia con il token.
    $svc = if ($all.Count -ge 2) { $all[1] } else { 'llmpod' }
    Invoke-Native { Invoke-Compose logs --tail 200 -f $svc }
    $script:Rc = $LASTEXITCODE; return
  }

  $client = $null
  $rest = $all
  if ($all.Count -ge 1 -and $all[0] -eq 'claude') { $client = 'claude'; $rest = @($all | Select-Object -Skip 1) }
  elseif ($all.Count -ge 2 -and $all[0] -eq 'run' -and -not $all[1].StartsWith('-')) { $client = $all[1]; $rest = @($all | Select-Object -Skip 2) }

  if (-not $client) {
    if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
      Invoke-Native { Invoke-Compose run --rm -T llmpod @all }
    } else {
      Invoke-Native { Invoke-Compose run --rm -it llmpod @all }
    }
    $script:Rc = $LASTEXITCODE; return
  }

  if ($client -eq 'zcode') {
    if (Get-Process ZCode -ErrorAction SilentlyContinue) {
      [Console]::Error.WriteLine("Chiudi ZCode e riprova: lo riscrive all'uscita e le modifiche andrebbero perse")
      $script:Rc = 1; return
    }
    Invoke-Native { Invoke-Compose run --rm -T llmpod run zcode --no-open @rest }
    $script:Rc = $LASTEXITCODE; return
  }

  # L'output di prepare contiene la chiave del profilo: non va mai stampato ne' scritto su file, solo valutato.
  # Se prepare fallisce si esce con lo stesso codice, senza eseguire nulla.
  $prep = Invoke-Native { Invoke-Compose run --rm -T llmpod prepare $client --format ps1 --host-config-dir $env:LLMPOD_CONFIG_DIR --host-pi-dir $env:PI_DIR @rest }
  if ($LASTEXITCODE -ne 0) { $script:Rc = $LASTEXITCODE; return }
  # Si valuta solo uno script fatto di righe "$env:..." / "& ...": altro = risposta inattesa (non stampata).
  $names = @()
  foreach ($l in @($prep)) {
    if ("$l" -notmatch '^(\$env:|& )') {
      [Console]::Error.WriteLine('Risposta inattesa da prepare: non eseguita')
      $script:Rc = 1; return
    }
    if ("$l" -match '^\$env:([A-Za-z0-9_]+) = ') { $names += $Matches[1] }
  }
  # Le variabili del client valgono solo per il suo avvio: i valori originali tornano al termine (vedi Restore-Env).
  Save-Env $names
  # L'ultima riga termina con "; exit $LASTEXITCODE": lo si toglie, cosi' l'esito si legge qui e il ripristino avviene sempre.
  $body = (@($prep) -join "`n") -replace ';\s*exit \$LASTEXITCODE\s*$', ''
  Invoke-Expression $body
  $script:Rc = $LASTEXITCODE; return
}

$script:Rc = 1
try {
  Invoke-Llmpod -CliArgs ([string[]]$args)
} finally {
  Restore-Env
}
exit $script:Rc
