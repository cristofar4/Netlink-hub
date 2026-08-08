#Requires -Version 5.1
<#
.SYNOPSIS
    NetLink, from zero to running on your phone. One script.

.DESCRIPTION
    Run this on your Windows PC. It checks what you have, installs what is
    missing that it can, sets everything up, and finishes by printing a QR code
    you scan with Expo Go on your phone.

    Your phone and this PC must be on the same Wi-Fi.

.EXAMPLE
    .\START-HERE.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

function Step { param($m) Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok   { param($m) Write-Host "    $m" -ForegroundColor Green }
function Warn { param($m) Write-Host "    $m" -ForegroundColor Yellow }
function Die  { param($m) Write-Host "    $m" -ForegroundColor Red; exit 1 }

Write-Host @'

  NetLink
  Secure remote access to your own computers.

'@ -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# 1. What is missing
# ---------------------------------------------------------------------------

Step 'Checking what you have'

$missing = @()
foreach ($tool in @(
    @{ Name = 'node';   Install = 'winget install OpenJS.NodeJS.LTS' },
    @{ Name = 'go';     Install = 'winget install GoLang.Go' },
    @{ Name = 'docker'; Install = 'winget install Docker.DockerDesktop' }
)) {
    if (Get-Command $tool.Name -ErrorAction SilentlyContinue) {
        Ok "$($tool.Name) found"
    } else {
        $missing += $tool
        Warn "$($tool.Name) is MISSING"
    }
}

if ($missing.Count -gt 0) {
    Write-Host ''
    Write-Host '  Install these first, then run this script again:' -ForegroundColor Yellow
    foreach ($tool in $missing) { Write-Host "      $($tool.Install)" }
    Write-Host ''
    Write-Host '  Close and reopen PowerShell after installing, so PATH updates.' -ForegroundColor Yellow
    exit 1
}

if (-not (docker info 2>$null)) {
    Die 'Docker is installed but not running. Open Docker Desktop, wait for it to start, then run this again.'
}
Ok 'Docker is running'

# ---------------------------------------------------------------------------
# 2. Your address on the network
# ---------------------------------------------------------------------------

Step 'Finding this PC on your network'

# The phone connects to this address, so it has to be the LAN one rather than
# loopback or a virtual adapter Docker or WSL created.
$address = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
        $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and
        $_.InterfaceAlias -notmatch 'Loopback|vEthernet|WSL|Docker'
    } |
    Sort-Object -Property SkipAsSource, InterfaceMetric |
    Select-Object -First 1 -ExpandProperty IPAddress

if (-not $address) { Die 'Could not find this PC''s network address. Are you connected to Wi-Fi?' }
Ok "This PC is $address"

# ---------------------------------------------------------------------------
# 3. Setup
# ---------------------------------------------------------------------------

Step 'Setting up (this takes a few minutes the first time)'
& (Join-Path $root 'scripts\setup-windows.ps1')

# The API listens on localhost by default, which the phone cannot reach.
Step 'Opening the API to your network'
$envFile = Join-Path $root '.env'
$content = Get-Content $envFile -Raw
if ($content -match '(?m)^HOST=127\.0\.0\.1') {
    $content = $content -replace '(?m)^HOST=127\.0\.0\.1', 'HOST=0.0.0.0'
    Set-Content -Path $envFile -Value $content -NoNewline
    Ok 'API will now accept connections from your phone'
} else {
    Ok 'Already open'
}

# ---------------------------------------------------------------------------
# 4. Go
# ---------------------------------------------------------------------------

Step 'Starting the API'
$api = Start-Process -PassThru -WindowStyle Minimized -FilePath 'cmd.exe' `
    -ArgumentList '/c', 'npm run dev --workspace=@netlink/api'

# Wait for it to answer before going further, so nothing starts against a
# server that is not listening yet.
$ready = $false
foreach ($attempt in 1..90) {
    try {
        Invoke-WebRequest -Uri 'http://127.0.0.1:4000/api/health/live' -TimeoutSec 2 -UseBasicParsing | Out-Null
        $ready = $true
        break
    } catch { Start-Sleep -Seconds 1 }
}
if (-not $ready) { Die 'The API did not start. Check the minimised window for the reason.' }
Ok 'API is up'

Write-Host ''
Write-Host '  ─────────────────────────────────────────────────────────' -ForegroundColor DarkGray
Write-Host '   Next: a QR code will appear below.' -ForegroundColor Cyan
Write-Host ''
Write-Host '   1. Install "Expo Go" from the Play Store on your phone'
Write-Host '   2. Open it and scan the QR code'
Write-Host '   3. NetLink loads on your phone'
Write-Host ''
Write-Host '   Create your account in the app. The six-digit code appears'
Write-Host '   in the API window, and also in the app response.'
Write-Host ''
Write-Host '   To make Power work, enrol this PC: open a second terminal,'
Write-Host '   run .\scripts\dev-windows.ps1, then My Spaces > Add a computer.'
Write-Host '  ─────────────────────────────────────────────────────────' -ForegroundColor DarkGray
Write-Host ''

$env:EXPO_PUBLIC_NETLINK_API_URL = "http://${address}:4000/api"
Ok "Phone app will connect to $env:EXPO_PUBLIC_NETLINK_API_URL"

try {
    Set-Location (Join-Path $root 'apps\mobile')
    & npx expo start
} finally {
    # Ctrl-C should not leave an API listening on 4000 that the next run then
    # fails to bind.
    if ($api -and -not $api.HasExited) { Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue }
    Set-Location $root
}
