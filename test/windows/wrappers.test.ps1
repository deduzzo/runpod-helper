# Prova dei wrapper PowerShell con un docker finto (nessuna credenziale, nessun Docker reale).
# Si lancia da CI su Windows con pwsh e con Windows PowerShell 5.1: powershell -File test\windows\wrappers.test.ps1
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('llmpod-ps-' + [guid]::NewGuid().ToString('N'))
$fakeBin = Join-Path $tmp 'bin'
$caller = Join-Path $tmp 'caller'
$profileDir = Join-Path $tmp 'home'
foreach ($d in @($fakeBin, $caller, $profileDir)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

$log = Join-Path $tmp 'docker.log'
$prepareFile = Join-Path $tmp 'prepare.txt'
$statusFile = Join-Path $tmp 'status.json'
Set-Content -Path $log -Value '' -Encoding ASCII
Set-Content -Path (Join-Path $fakeBin 'docker.cmd') -Encoding ASCII -Value @(
  '@echo off',
  'echo %* >> "%FAKE_LOG%"',
  'echo %* | findstr /C:" prepare claude" >nul',
  'if not errorlevel 1 (type "%FAKE_PREPARE%" & exit /b 0)',
  'echo %* | findstr /C:"status --json" >nul',
  'if not errorlevel 1 (type "%FAKE_STATUS%" & exit /b 0)',
  'exit /b 0'
)
Set-Content -Path $prepareFile -Encoding ASCII -Value @(
  "`$env:ANTHROPIC_BASE_URL = 'https://p1-8000.proxy.runpod.net'",
  "`$env:LLMPOD_TEST_NEW = 'x'",
  "& 'cmd' '/c' 'cd'; exit `$LASTEXITCODE"
)
Set-Content -Path $statusFile -Encoding ASCII -Value '{"pods":[{"profile":"qwen","podId":"abc123","state":"running"},{"profile":"glm","podId":"old777","state":"stopped"}],"balance":null,"volume":null}'

$env:FAKE_LOG = $log
$env:FAKE_PREPARE = $prepareFile
$env:FAKE_STATUS = $statusFile
$env:PATH = "$fakeBin;$env:PATH"
$env:USERPROFILE = $profileDir
foreach ($n in 'LLMPOD_CONFIG_DIR', 'ZCODE_DIR', 'PI_DIR', 'LLMPOD_UID', 'LLMPOD_GID', 'LLMPOD_HOST_OS', 'LLMPOD_OPENWEBUI_KEY', 'LLMPOD_OPENWEBUI_PORT', 'PI_CODING_AGENT_DIR', 'LLMPOD_TEST_NEW') {
  Remove-Item "Env:$n" -ErrorAction SilentlyContinue
}
$env:ANTHROPIC_BASE_URL = 'originale'
Set-Location $caller
$expectedDir = (Get-Location).Path

# Con 'Stop' lo stderr dei comandi nativi (2>&1) sarebbe un errore bloccante in Windows PowerShell 5.1: gli esiti si verificano con i controlli.
$ErrorActionPreference = 'Continue'
$script:failures = 0
function Check([bool]$Condition, [string]$Message) {
  if ($Condition) { Write-Host "ok: $Message" } else { Write-Host "FAIL: $Message"; $script:failures++ }
}
function Read-Log { (Get-Content $log -Raw) }

# 1. run claude: il client parte dalla cartella del chiamante e la sessione resta com'era.
$out = (& (Join-Path $repo 'bin\llmpod.ps1') run claude 2>&1 | Out-String)
Check ($LASTEXITCODE -eq 0) 'run claude: uscita 0'
Check ($out.Contains($expectedDir)) "il client parte dalla cartella del chiamante ($expectedDir)"
Check ((Get-Location).Path -eq $expectedDir) 'la cartella corrente non cambia'
Check ($env:ANTHROPIC_BASE_URL -eq 'originale') 'variabile preesistente del client ripristinata'
Check ($null -eq $env:LLMPOD_TEST_NEW) "variabile nuova del client rimossa (valore: '$($env:LLMPOD_TEST_NEW)')"
Check ($null -eq $env:LLMPOD_CONFIG_DIR -and $null -eq $env:LLMPOD_HOST_OS -and $null -eq $env:LLMPOD_UID) "variabili del wrapper rimosse dalla sessione (CONFIG_DIR='$($env:LLMPOD_CONFIG_DIR)' HOST_OS='$($env:LLMPOD_HOST_OS)' UID='$($env:LLMPOD_UID)')"
$calls = Read-Log
Check ($calls.Contains('--project-directory') -and $calls.Contains('compose.yaml')) 'compose usa --project-directory e -f'
Check ($calls.Contains('run --rm -T llmpod prepare claude --format ps1')) 'prepare eseguito nel container'

# 2. logs, ui
Set-Content -Path $log -Value '' -Encoding ASCII
& (Join-Path $repo 'bin\llmpod.ps1') logs 2>&1 | Out-Null
Check ((Read-Log).Contains('logs --tail 200 -f llmpod')) 'logs: ultimi 200 log del servizio llmpod'
& (Join-Path $repo 'bin\llmpod.ps1') ui 2>&1 | Out-Null
Check ($LASTEXITCODE -eq 1) 'ui: uscita 1'

# 3. llmpod.cmd (ExecutionPolicy Bypass) propaga l'esito
& (Join-Path $repo 'bin\llmpod.cmd') ui 2>&1 | Out-Null
Check ($LASTEXITCODE -eq 1) 'llmpod.cmd: propaga l''uscita'

# 4. stop: avviso sui Pod attivi (processo figlio: il messaggio va su stderr)
$cfg = Join-Path $profileDir '.config\llmpod'
New-Item -ItemType Directory -Force -Path $cfg | Out-Null
Set-Content -Path (Join-Path $cfg '.env') -Encoding ASCII -Value 'RUNPOD_API_KEY=rpa_FINTA'
$psExe = (Get-Process -Id $PID).Path
Set-Content -Path $log -Value '' -Encoding ASCII
$stopOut = (& $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'scripts\stop.ps1') 2>&1 | Out-String)
Check ($LASTEXITCODE -eq 0) 'stop: uscita 0'
Check ($stopOut -match 'Il Pod abc123 del profilo qwen resta acceso e a pagamento: eliminalo con') 'stop: avviso sul Pod attivo'
Check ($stopOut -match 'Il Pod old777 del profilo glm .* spento ma costa ancora lo spazio su disco') 'stop: avviso sul Pod spento'
Check ((Read-Log).Contains('--profile openwebui down')) 'stop: ferma i container'

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
if ($script:failures -gt 0) { Write-Host "$($script:failures) controlli falliti"; exit 1 }
Write-Host 'Tutti i controlli superati'
exit 0
