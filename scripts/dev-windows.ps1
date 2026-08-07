#Requires -Version 5.1
<#
.SYNOPSIS
    Runs NetLink for development.

.DESCRIPTION
    Starts PostgreSQL if it is not already up, launches the API, and then runs
    the desktop app through Wails with hot reload. Ctrl+C stops everything it
    started.

.EXAMPLE
    .\scripts\dev-windows.ps1
    Everything: database, API and the NetLink window.

.EXAMPLE
    .\scripts\dev-windows.ps1 -ApiOnly
    Just the API, for working on the backend or testing with curl.

.EXAMPLE
    .\scripts\dev-windows.ps1 -Agent
    Also runs the background agent in the foreground, with verbose logging.
#>
[CmdletBinding()]
param(
    [switch]$ApiOnly,
    [switch]$DesktopOnly,
    [switch]$Agent,
    [switch]$SkipDatabase
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

function Write-Step { param([string]$m) Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Write-Ok   { param([string]$m) Write-Host "  [ok]   $m" -ForegroundColor Green }
function Write-Warn { param([string]$m) Write-Host "  [warn] $m" -ForegroundColor Yellow }
function Write-Info { param([string]$m) Write-Host "         $m" -ForegroundColor DarkGray }

if (-not (Test-Path (Join-Path $RepoRoot '.env'))) {
    Write-Host 'No .env found. Run .\scripts\setup-windows.ps1 first.' -ForegroundColor Red
    exit 1
}

# Load .env into this session so the child processes inherit it.
Get-Content (Join-Path $RepoRoot '.env') | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) { return }
    $separator = $line.IndexOf('=')
    if ($separator -lt 1) { return }
    $key = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1).Trim().Trim('"')
    [Environment]::SetEnvironmentVariable($key, $value, 'Process')
}

$started = @()

# Stop whatever this script started, whether it ends normally or with Ctrl+C.
function Stop-Started {
    foreach ($process in $started) {
        if ($process -and -not $process.HasExited) {
            Write-Info "Stopping $($process.ProcessName) (pid $($process.Id))…"
            try { $process.Kill($true) } catch { }
        }
    }
}
trap { Stop-Started; break }

try {
    # ---------------------------------------------------------------------
    # Database
    # ---------------------------------------------------------------------
    if (-not $SkipDatabase -and -not $DesktopOnly) {
        Write-Step 'PostgreSQL'
        $running = (& docker compose ps --status running --services 2>$null) -contains 'postgres'
        if ($running) {
            Write-Ok 'Already running.'
        } else {
            & docker compose up -d postgres mailpit
            if ($LASTEXITCODE -ne 0) {
                Write-Warn 'Could not start PostgreSQL with Docker.'
                Write-Info 'If you run your own PostgreSQL, re-run with -SkipDatabase.'
                exit 1
            }
            foreach ($attempt in 1..30) {
                & docker compose exec -T postgres pg_isready -U netlink -d netlink *> $null
                if ($LASTEXITCODE -eq 0) { break }
                Start-Sleep -Seconds 2
            }
            Write-Ok 'PostgreSQL is ready.'
        }
    }

    # ---------------------------------------------------------------------
    # API
    # ---------------------------------------------------------------------
    if (-not $DesktopOnly) {
        Write-Step 'NetLink API'
        $api = Start-Process -FilePath 'npm' `
            -ArgumentList 'run', 'dev', '--workspace=@netlink/api' `
            -WorkingDirectory $RepoRoot -PassThru -NoNewWindow
        $started += $api

        $apiUrl = "http://127.0.0.1:$($env:PORT ?? '4000')/api/health/live"
        $up = $false
        foreach ($attempt in 1..45) {
            Start-Sleep -Seconds 1
            try {
                $response = Invoke-WebRequest -Uri $apiUrl -UseBasicParsing -TimeoutSec 2
                if ($response.StatusCode -eq 200) { $up = $true; break }
            } catch { }
        }
        if ($up) {
            Write-Ok "API is up on http://127.0.0.1:$($env:PORT ?? '4000')/api"
            Write-Info "API docs: http://127.0.0.1:$($env:PORT ?? '4000')/docs"
        } else {
            Write-Warn 'The API has not answered yet — watch the output above for the reason.'
        }
    }

    if ($ApiOnly) {
        Write-Host "`nAPI is running. Press Ctrl+C to stop.`n" -ForegroundColor Green
        Wait-Process -Id $api.Id
        return
    }

    # ---------------------------------------------------------------------
    # Agent (optional)
    # ---------------------------------------------------------------------
    if ($Agent) {
        Write-Step 'NetLink agent'
        $agentProcess = Start-Process -FilePath 'go' `
            -ArgumentList 'run', './cmd/netlink-agent', 'run', '-v' `
            -WorkingDirectory (Join-Path $RepoRoot 'services\agent') -PassThru -NoNewWindow
        $started += $agentProcess
        Write-Ok 'Agent started in the foreground.'
        Write-Info 'It generates this machine''s device identity on first run and protects it with DPAPI.'
    }

    # ---------------------------------------------------------------------
    # Desktop app
    # ---------------------------------------------------------------------
    Write-Step 'NetLink desktop app'
    if (-not (Get-Command 'wails' -ErrorAction SilentlyContinue)) {
        $goBin = Join-Path (& go env GOPATH) 'bin'
        if (Test-Path (Join-Path $goBin 'wails.exe')) {
            $env:PATH = "$env:PATH;$goBin"
        } else {
            Write-Host 'The Wails CLI was not found. Run .\scripts\setup-windows.ps1 first.' -ForegroundColor Red
            exit 1
        }
    }

    Write-Info 'Starting Wails in development mode — the window opens with hot reload.'
    Push-Location (Join-Path $RepoRoot 'apps\desktop')
    try {
        & wails dev
    } finally { Pop-Location }
}
finally {
    Stop-Started
    Write-Host "`nStopped. PostgreSQL is still running — 'docker compose down' stops it.`n" -ForegroundColor DarkGray
}
