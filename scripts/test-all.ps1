#Requires -Version 5.1
<#
.SYNOPSIS
    Runs every NetLink check: formatting, linting, type checking, Go tests,
    API tests, frontend tests and production builds.

.DESCRIPTION
    This is the gate. A phase is not complete while any of it fails.

    The API integration tests need PostgreSQL, because they exercise the real
    guards against real SQL — a mocked repository would prove nothing about
    whether a revoked device is actually refused.

.EXAMPLE
    .\scripts\test-all.ps1

.EXAMPLE
    .\scripts\test-all.ps1 -SkipBuilds
    Faster loop while iterating; run the full gate before you commit.
#>
[CmdletBinding()]
param(
    [switch]$SkipBuilds,
    [switch]$SkipIntegration,
    [switch]$FixFormatting
)

$ErrorActionPreference = 'Continue'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$script:Results = @()

function Invoke-Check {
    param(
        [string]$Name,
        [string]$WorkingDirectory,
        [scriptblock]$Command
    )

    Write-Host "`n=== $Name ===" -ForegroundColor Cyan
    $started = Get-Date

    Push-Location (Join-Path $RepoRoot $WorkingDirectory)
    try {
        & $Command
        $exitCode = $LASTEXITCODE
    } catch {
        Write-Host $_.Exception.Message -ForegroundColor Red
        $exitCode = 1
    } finally {
        Pop-Location
    }

    $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    if ($exitCode -eq 0) {
        Write-Host "  PASS  ($seconds s)" -ForegroundColor Green
    } else {
        Write-Host "  FAIL  ($seconds s)" -ForegroundColor Red
    }

    $script:Results += [pscustomobject]@{
        Name    = $Name
        Passed  = ($exitCode -eq 0)
        Seconds = $seconds
    }
}

Write-Host @'

  NetLink — full check
  Formatting, linting, types, Go tests, API tests, frontend tests, builds.

'@ -ForegroundColor Blue

# --------------------------------------------------------------------------
# Formatting
# --------------------------------------------------------------------------

if ($FixFormatting) {
    Invoke-Check 'Prettier (writing)' '.' { & npx prettier --write "**/*.{ts,tsx,js,json,css}" }
    Invoke-Check 'gofmt (writing)'     'services\agent' { & gofmt -w . }
    Invoke-Check 'gofmt desktop (writing)' 'apps\desktop' { & gofmt -w . }
} else {
    Invoke-Check 'Prettier' '.' { & npx prettier --check "**/*.{ts,tsx,js,json,css}" }

    Invoke-Check 'gofmt (agent)' 'services\agent' {
        $unformatted = & gofmt -l .
        if ($unformatted) {
            Write-Host "These files are not gofmt-clean:" -ForegroundColor Red
            $unformatted | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
            Write-Host "Fix with: .\scripts\test-all.ps1 -FixFormatting" -ForegroundColor DarkGray
            $global:LASTEXITCODE = 1
        } else { $global:LASTEXITCODE = 0 }
    }

    Invoke-Check 'gofmt (desktop)' 'apps\desktop' {
        $unformatted = & gofmt -l .
        if ($unformatted) {
            $unformatted | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
            $global:LASTEXITCODE = 1
        } else { $global:LASTEXITCODE = 0 }
    }
}

# --------------------------------------------------------------------------
# Linting and types
# --------------------------------------------------------------------------

Invoke-Check 'ESLint (API)' 'apps\api' { & npm run lint }

Invoke-Check 'go vet (agent)'   'services\agent' { & go vet ./... }
Invoke-Check 'go vet (desktop)' 'apps\desktop'   { & go vet ./... }

Invoke-Check 'TypeScript (contracts)' 'packages\contracts' { & npx tsc -p tsconfig.json --noEmit }
Invoke-Check 'TypeScript (ui)'        'packages\ui'        { & npx tsc -p tsconfig.json --noEmit }
Invoke-Check 'TypeScript (API)'       'apps\api'           { & npx tsc -p tsconfig.json --noEmit }
Invoke-Check 'TypeScript (frontend)'  'apps\desktop\frontend' { & npx tsc -b --force }

# --------------------------------------------------------------------------
# Tests
# --------------------------------------------------------------------------

Invoke-Check 'Go tests (agent)' 'services\agent' { & go test -timeout 120s ./... }

# The Windows build path carries the DPAPI key store, which does not compile on
# any other platform — so it must be built explicitly, not just assumed.
Invoke-Check 'Go build for Windows (agent)' 'services\agent' {
    $env:GOOS = 'windows'; $env:GOARCH = 'amd64'
    & go build ./...
    Remove-Item Env:GOOS, Env:GOARCH -ErrorAction SilentlyContinue
}

Invoke-Check 'Contract tests' 'packages\contracts' { & npx vitest run }

if ($SkipIntegration) {
    Write-Host "`n=== API tests ===" -ForegroundColor Cyan
    Write-Host '  SKIPPED (-SkipIntegration)' -ForegroundColor Yellow
} else {
    Invoke-Check 'API tests (unit + integration)' 'apps\api' {
        # Integration tests share one PostgreSQL schema and truncate between
        # cases, so they must not run in parallel.
        & npx jest --config jest.config.js --runInBand
    }
}

Invoke-Check 'Frontend tests' 'apps\desktop\frontend' { & npx vitest run }

# --------------------------------------------------------------------------
# Production builds
# --------------------------------------------------------------------------

if (-not $SkipBuilds) {
    Invoke-Check 'Build contracts' 'packages\contracts'      { & npm run build }
    Invoke-Check 'Build API'       'apps\api'                { & npm run build }
    Invoke-Check 'Build frontend'  'apps\desktop\frontend'   { & npm run build }
    Invoke-Check 'Build agent'     'services\agent'          { & go build -o bin\netlink-agent.exe .\cmd\netlink-agent }

    if (Get-Command 'wails' -ErrorAction SilentlyContinue) {
        Invoke-Check 'Build NetLink desktop app' 'apps\desktop' { & wails build -clean }
    } else {
        Write-Host "`n=== Build NetLink desktop app ===" -ForegroundColor Cyan
        Write-Host '  SKIPPED (the Wails CLI is not on PATH)' -ForegroundColor Yellow
    }
}

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------

Write-Host "`n`n================ SUMMARY ================" -ForegroundColor Blue
foreach ($result in $script:Results) {
    $status = if ($result.Passed) { 'PASS' } else { 'FAIL' }
    $colour = if ($result.Passed) { 'Green' } else { 'Red' }
    Write-Host ('  {0,-4}  {1,-38} {2,6} s' -f $status, $result.Name, $result.Seconds) -ForegroundColor $colour
}

$failed = @($script:Results | Where-Object { -not $_.Passed })
Write-Host '========================================' -ForegroundColor Blue

if ($failed.Count -gt 0) {
    Write-Host "`n$($failed.Count) of $($script:Results.Count) checks failed.`n" -ForegroundColor Red
    exit 1
}

Write-Host "`nAll $($script:Results.Count) checks passed.`n" -ForegroundColor Green
exit 0
