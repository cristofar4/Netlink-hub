#Requires -Version 5.1
<#
.SYNOPSIS
    Prepares a Windows machine to build and run NetLink.

.DESCRIPTION
    Checks every prerequisite, reports exactly what is missing and how to get
    it, then installs dependencies, writes a .env with freshly generated
    secrets, starts PostgreSQL and applies the database migrations.

    Safe to run repeatedly. It never overwrites an existing .env — a regenerated
    JWT secret would sign every existing session out.

.EXAMPLE
    .\scripts\setup-windows.ps1

.EXAMPLE
    .\scripts\setup-windows.ps1 -SkipDatabase
    Skips Docker and the migrations, for a machine with its own PostgreSQL.
#>
[CmdletBinding()]
param(
    [switch]$SkipDatabase,
    [switch]$SkipWails
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

# --------------------------------------------------------------------------
# Output helpers
# --------------------------------------------------------------------------

function Write-Step    { param([string]$Message) Write-Host "`n=== $Message ===" -ForegroundColor Cyan }
function Write-Ok      { param([string]$Message) Write-Host "  [ok]   $Message" -ForegroundColor Green }
function Write-Warn    { param([string]$Message) Write-Host "  [warn] $Message" -ForegroundColor Yellow }
function Write-Fail    { param([string]$Message) Write-Host "  [fail] $Message" -ForegroundColor Red }
function Write-Info    { param([string]$Message) Write-Host "         $Message" -ForegroundColor DarkGray }

$script:Problems = @()
function Add-Problem {
    param([string]$What, [string]$Fix)
    $script:Problems += [pscustomobject]@{ What = $What; Fix = $Fix }
    Write-Fail $What
    Write-Info $Fix
}

# --------------------------------------------------------------------------
# Version checks
# --------------------------------------------------------------------------

function Get-CommandVersion {
    param([string]$Command, [string[]]$VersionArgs = @('--version'))
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { return $null }
    try { return (& $Command @VersionArgs 2>&1 | Out-String).Trim() } catch { return $null }
}

function Test-MinimumVersion {
    param([string]$Found, [string]$Minimum)
    $match = [regex]::Match($Found, '(\d+)\.(\d+)(?:\.(\d+))?')
    if (-not $match.Success) { return $false }
    $foundVersion = [version]::new(
        [int]$match.Groups[1].Value,
        [int]$match.Groups[2].Value,
        $(if ($match.Groups[3].Success) { [int]$match.Groups[3].Value } else { 0 })
    )
    return $foundVersion -ge [version]$Minimum
}

Write-Host @'

  NetLink — Windows setup
  Secure remote access to your own computers, files, printers and shared data.

'@ -ForegroundColor Blue

Write-Step 'Checking prerequisites'

# --- Node.js --------------------------------------------------------------
$node = Get-CommandVersion 'node'
if (-not $node) {
    Add-Problem 'Node.js is not installed.' 'Install Node.js 20 LTS or newer: winget install OpenJS.NodeJS.LTS'
} elseif (-not (Test-MinimumVersion $node '20.11.0')) {
    Add-Problem "Node.js $node is too old (need 20.11 or newer)." 'winget upgrade OpenJS.NodeJS.LTS'
} else {
    Write-Ok "Node.js $node"
}

# --- npm ------------------------------------------------------------------
$npm = Get-CommandVersion 'npm'
if (-not $npm) {
    Add-Problem 'npm is not available.' 'It ships with Node.js — reinstall Node.js.'
} elseif (-not (Test-MinimumVersion $npm '10.0.0')) {
    Add-Problem "npm $npm is too old (need 10 or newer)." 'npm install -g npm@latest'
} else {
    Write-Ok "npm $npm"
}

# --- Go -------------------------------------------------------------------
# Wails v2.13 requires Go 1.25 or newer.
$go = Get-CommandVersion 'go' @('version')
if (-not $go) {
    Add-Problem 'Go is not installed.' 'Install Go 1.25 or newer: winget install GoLang.Go'
} elseif (-not (Test-MinimumVersion $go '1.25.0')) {
    Add-Problem "Go ($go) is too old — Wails v2.13 needs Go 1.25 or newer." 'winget upgrade GoLang.Go'
} else {
    Write-Ok $go
}

# --- WebView2 -------------------------------------------------------------
# Wails renders through WebView2. Windows 11 and current Windows 10 ship it,
# but a freshly-imaged or LTSC machine may not have it.
$webview2Keys = @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
$webview2 = $webview2Keys |
    ForEach-Object { Get-ItemProperty -Path $_ -Name pv -ErrorAction SilentlyContinue } |
    Select-Object -First 1

if ($webview2 -and $webview2.pv -and $webview2.pv -ne '0.0.0.0') {
    Write-Ok "WebView2 runtime $($webview2.pv)"
} else {
    Add-Problem 'The WebView2 runtime was not found — the NetLink window cannot render without it.' `
                'winget install Microsoft.EdgeWebView2Runtime  (or download the Evergreen Bootstrapper from Microsoft)'
}

# --- Wails ----------------------------------------------------------------
if (-not $SkipWails) {
    $wails = Get-CommandVersion 'wails' @('version')
    if (-not $wails) {
        Write-Warn 'The Wails CLI is not installed. Installing it now…'
        try {
            & go install github.com/wailsapp/wails/v2/cmd/wails@v2.13.0
            $goBin = Join-Path (& go env GOPATH) 'bin'
            if ($env:PATH -notlike "*$goBin*") {
                $env:PATH = "$env:PATH;$goBin"
                Write-Warn "Added $goBin to PATH for this session."
                Write-Info "Add it permanently so `wails` works in new terminals:"
                Write-Info "  [Environment]::SetEnvironmentVariable('PATH', `"`$env:PATH;$goBin`", 'User')"
            }
            Write-Ok 'Wails CLI installed.'
        } catch {
            Add-Problem 'Could not install the Wails CLI.' 'go install github.com/wailsapp/wails/v2/cmd/wails@v2.13.0'
        }
    } else {
        Write-Ok "Wails $($wails -split "`n" | Select-Object -First 1)"
    }
}

# --- Database -------------------------------------------------------------
if (-not $SkipDatabase) {
    $docker = Get-CommandVersion 'docker'
    if (-not $docker) {
        Write-Warn 'Docker is not installed.'
        Write-Info 'Either install Docker Desktop (winget install Docker.DockerDesktop),'
        Write-Info 'or point DATABASE_URL at your own PostgreSQL and re-run with -SkipDatabase.'
    } else {
        Write-Ok $docker
        try {
            & docker info *> $null
            if ($LASTEXITCODE -ne 0) { throw 'not running' }
            Write-Ok 'Docker daemon is running.'
        } catch {
            Add-Problem 'Docker is installed but not running.' 'Start Docker Desktop and run this script again.'
        }
    }
}

if ($script:Problems.Count -gt 0) {
    Write-Host "`n" -NoNewline
    Write-Host "Setup cannot continue until these are fixed:" -ForegroundColor Red
    foreach ($problem in $script:Problems) {
        Write-Host "  * $($problem.What)" -ForegroundColor Red
        Write-Host "    $($problem.Fix)" -ForegroundColor DarkGray
    }
    exit 1
}

# --------------------------------------------------------------------------
# Environment file
# --------------------------------------------------------------------------

Write-Step 'Environment'

$envPath = Join-Path $RepoRoot '.env'
if (Test-Path $envPath) {
    Write-Ok '.env already exists — leaving it alone.'
    Write-Info 'Delete it and re-run if you want fresh secrets. Every device will need to sign in again.'
} else {
    $bytes = [byte[]]::new(48)
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $jwtSecret = [Convert]::ToBase64String($bytes)

    (Get-Content (Join-Path $RepoRoot '.env.example') -Raw).
        Replace('JWT_ACCESS_SECRET=change-me-to-at-least-32-random-characters', "JWT_ACCESS_SECRET=$jwtSecret") |
        Set-Content -Path $envPath -Encoding UTF8 -NoNewline

    Write-Ok 'Wrote .env with a freshly generated signing key.'
    Write-Info 'It is git-ignored. Do not commit it.'
}

# --------------------------------------------------------------------------
# Dependencies
# --------------------------------------------------------------------------

Write-Step 'Installing JavaScript dependencies'
& npm install
if ($LASTEXITCODE -ne 0) { Write-Fail 'npm install failed.'; exit 1 }
Write-Ok 'Workspace dependencies installed.'

Write-Step 'Downloading Go modules'
foreach ($module in @('services\agent', 'apps\desktop')) {
    Push-Location (Join-Path $RepoRoot $module)
    try {
        & go mod download
        if ($LASTEXITCODE -ne 0) { Write-Fail "go mod download failed in $module"; exit 1 }
        Write-Ok "$module"
    } finally { Pop-Location }
}

# --------------------------------------------------------------------------
# Database
# --------------------------------------------------------------------------

if (-not $SkipDatabase) {
    Write-Step 'Starting PostgreSQL'
    & docker compose up -d postgres mailpit
    if ($LASTEXITCODE -ne 0) { Write-Fail 'docker compose failed.'; exit 1 }

    Write-Info 'Waiting for PostgreSQL to accept connections…'
    $ready = $false
    foreach ($attempt in 1..30) {
        & docker compose exec -T postgres pg_isready -U netlink -d netlink *> $null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 2
    }
    if (-not $ready) {
        Write-Fail 'PostgreSQL did not become ready within 60 seconds.'
        Write-Info 'Check it with: docker compose logs postgres'
        exit 1
    }
    Write-Ok 'PostgreSQL is ready on 127.0.0.1:5432'
    Write-Ok 'Mailpit is on http://localhost:8025 — set MAIL_TRANSPORT=smtp, SMTP_HOST=localhost, SMTP_PORT=1025 to use it.'
}

Write-Step 'Applying database migrations'
Push-Location (Join-Path $RepoRoot 'apps\api')
try {
    & npx prisma migrate deploy
    if ($LASTEXITCODE -ne 0) { Write-Fail 'Migrations failed.'; exit 1 }
    & npx prisma generate
    Write-Ok 'Database schema is up to date.'
} finally { Pop-Location }

# --------------------------------------------------------------------------
# Done
# --------------------------------------------------------------------------

Write-Host @'

  Setup complete.

  Start everything:      .\scripts\dev-windows.ps1
  Run all the checks:    .\scripts\test-all.ps1

  Once running:
    API            http://127.0.0.1:4000/api
    API docs       http://127.0.0.1:4000/docs
    Mailbox        http://localhost:8025

  EXPOSE_DEV_OTP is true in .env, so the six-digit codes come back in the API
  response and appear in the API log. The API refuses to start with that
  enabled in production.

'@ -ForegroundColor Green
