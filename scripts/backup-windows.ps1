#Requires -Version 5.1
<#
.SYNOPSIS
    Takes a verified, compressed backup of the NetLink database.

.DESCRIPTION
    What is in a NetLink backup, and what deliberately is not:

    IN:   accounts, Argon2id password hashes, device public keys, Space
          membership, permission grants, data allocations, the audit trail.

    NOT IN, because it is never stored:
          raw passwords, verification codes (only SHA-256 hashes), device
          private keys (they never leave the machine that made them), file
          contents (transfers are peer to peer), remote desktop frames or
          keystrokes (also peer to peer), print documents (dropped the moment
          the agent collects them).

    That means a stolen backup is serious — it is everyone's email address and
    their audit history — but it is not a way into anybody's files or machines.
    Treat it accordingly: encrypt it at rest, and keep it somewhere the API
    server cannot reach, so ransomware on the server cannot also take the
    backups.

    Every backup is VERIFIED after it is written, by restoring it into a
    throwaway database. An unverified backup is a belief, not a backup, and the
    moment you find out otherwise is the worst possible moment.

.PARAMETER Destination
    Directory to write to. Created if missing.

.PARAMETER KeepDays
    Delete backups older than this. Default 30. Set to 0 to keep everything.

.PARAMETER SkipVerify
    Skip the restore check. Only for a machine without room for a second copy —
    and note in your runbook that these backups are unverified.

.EXAMPLE
    .\scripts\backup-windows.ps1 -Destination D:\netlink-backups

.EXAMPLE
    .\scripts\backup-windows.ps1 -Destination \\nas\backups\netlink -KeepDays 90
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Destination,

    [int]$KeepDays = 30,

    [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "    $Message" -ForegroundColor Yellow }

# --- Configuration ---------------------------------------------------------

$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) {
    throw "No .env found at $envFile. Run scripts\setup-windows.ps1 first."
}

$databaseUrl = $null
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*DATABASE_URL\s*=\s*(.+)\s*$') {
        $databaseUrl = $Matches[1].Trim('"').Trim("'")
    }
}
if (-not $databaseUrl) { throw 'DATABASE_URL is not set in .env.' }

foreach ($tool in @('pg_dump', 'psql')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool is not on PATH. Install the PostgreSQL client tools, or add its bin directory to PATH."
    }
}

if (-not (Test-Path $Destination)) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
}

# --- Dump ------------------------------------------------------------------

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dumpFile = Join-Path $Destination "netlink-$stamp.dump"

Write-Step "Backing up to $dumpFile"

# Custom format (-Fc): compressed, and restorable selectively, which matters
# when you need one table back rather than the whole database.
& pg_dump --dbname=$databaseUrl --format=custom --compress=9 --no-owner --no-privileges --file=$dumpFile
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE." }

$size = (Get-Item $dumpFile).Length
if ($size -lt 1024) {
    Remove-Item $dumpFile -Force
    throw "The dump is only $size bytes — that is not a real backup. Nothing was kept."
}
Write-Ok ("Wrote {0:N1} MB" -f ($size / 1MB))

# A checksum beside it, so a corrupted copy is detectable without a restore.
$hash = (Get-FileHash -Path $dumpFile -Algorithm SHA256).Hash.ToLower()
"$hash  $(Split-Path -Leaf $dumpFile)" | Set-Content -Path "$dumpFile.sha256" -Encoding ASCII
Write-Ok "SHA-256 $($hash.Substring(0, 16))…"

# --- Verify ----------------------------------------------------------------

if ($SkipVerify) {
    Write-Warn 'Verification skipped. This backup has not been proven restorable.'
}
else {
    Write-Step 'Verifying by restoring into a throwaway database'

    $verifyDb = "netlink_verify_$stamp"
    # The maintenance connection: same server, the always-present `postgres`
    # database, so the temporary one can be created and dropped.
    $adminUrl = $databaseUrl -replace '/[^/?]+(\?|$)', "/postgres`$1"

    try {
        & psql --dbname=$adminUrl --quiet --command="CREATE DATABASE ""$verifyDb"";" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the verification database.' }

        $targetUrl = $databaseUrl -replace '/[^/?]+(\?|$)', "/$verifyDb`$1"
        & pg_restore --dbname=$targetUrl --no-owner --no-privileges $dumpFile 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'pg_restore failed. This backup is NOT usable.' }

        # A restore that produces an empty schema is a restore that succeeded at
        # nothing. Count something that must exist.
        $tables = & psql --dbname=$targetUrl --tuples-only --no-align --command="SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';"
        if ([int]$tables -lt 10) {
            throw "The restored database has only $tables tables. This backup is NOT usable."
        }
        Write-Ok "Restored and checked — $tables tables"
    }
    finally {
        & psql --dbname=$adminUrl --quiet --command="DROP DATABASE IF EXISTS ""$verifyDb"";" | Out-Null
    }
}

# --- Retention -------------------------------------------------------------

if ($KeepDays -gt 0) {
    $cutoff = (Get-Date).AddDays(-$KeepDays)
    $old = Get-ChildItem -Path $Destination -Filter 'netlink-*.dump' |
        Where-Object { $_.LastWriteTime -lt $cutoff }

    # Never delete the last copy, whatever the retention says. A clock that is
    # wrong by a year should not be able to leave you with nothing.
    $remaining = (Get-ChildItem -Path $Destination -Filter 'netlink-*.dump').Count - $old.Count
    if ($remaining -lt 1) {
        Write-Warn 'Retention would remove every backup. Keeping the most recent one.'
        $old = $old | Sort-Object LastWriteTime | Select-Object -SkipLast 1
    }

    foreach ($file in $old) {
        Remove-Item $file.FullName -Force
        Remove-Item "$($file.FullName).sha256" -Force -ErrorAction SilentlyContinue
        Write-Ok "Removed $($file.Name)"
    }
}

Write-Host ''
Write-Host 'Backup complete.' -ForegroundColor Green
Write-Host "  File: $dumpFile"
Write-Host '  Restore with: .\scripts\restore-windows.ps1 -BackupFile <path>'
Write-Host ''
Write-Host 'Reminders:' -ForegroundColor Yellow
Write-Host '  * Keep a copy somewhere the API server cannot write to.'
Write-Host '  * Encrypt it at rest. It contains every account and the audit trail.'
Write-Host '  * Restore into a scratch database on a schedule. A backup nobody has'
Write-Host '    restored is a belief, not a backup.'
