#Requires -Version 5.1
<#
.SYNOPSIS
    Restores a NetLink backup.

.DESCRIPTION
    Restoring is destructive and this script treats it that way: it will not
    overwrite a live database unless you type the database name to confirm, and
    it refuses outright while the API is still reachable — restoring underneath
    a running server produces a mixture of old and new rows that is worse than
    either.

    What restoring does NOT bring back, because it was never in the backup:

      * device private keys — every device keeps its own, so after a restore
        each one re-authenticates with the key it already has. Nothing to do.
      * file contents, remote desktop frames, print documents — none of these
        were ever on the server.

    What restoring DOES roll back: accounts created since the backup, devices
    trusted since, permission changes since, and the audit trail since. Say so
    to whoever is affected; an audit trail with a silent gap is worse than one
    with a documented one.

.PARAMETER BackupFile
    The .dump file to restore.

.PARAMETER Force
    Skip the confirmation prompt. For automated disaster-recovery drills.

.EXAMPLE
    .\scripts\restore-windows.ps1 -BackupFile D:\netlink-backups\netlink-20260808-020000.dump
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BackupFile,

    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "    $Message" -ForegroundColor Green }

if (-not (Test-Path $BackupFile)) { throw "No such file: $BackupFile" }

# --- Integrity -------------------------------------------------------------

$checksumFile = "$BackupFile.sha256"
if (Test-Path $checksumFile) {
    Write-Step 'Checking the backup against its recorded checksum'
    $expected = (Get-Content $checksumFile -Raw).Split(' ')[0].Trim().ToLower()
    $actual = (Get-FileHash -Path $BackupFile -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) {
        throw "Checksum mismatch. This file is not the backup that was taken. Refusing to restore it."
    }
    Write-Ok 'Checksum matches'
}
else {
    Write-Host '    No .sha256 beside this backup — its integrity cannot be checked.' -ForegroundColor Yellow
}

# --- Configuration ---------------------------------------------------------

$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) { throw "No .env found at $envFile." }

$databaseUrl = $null
$port = '4000'
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*DATABASE_URL\s*=\s*(.+)\s*$') { $databaseUrl = $Matches[1].Trim('"').Trim("'") }
    if ($_ -match '^\s*PORT\s*=\s*(\d+)\s*$') { $port = $Matches[1] }
}
if (-not $databaseUrl) { throw 'DATABASE_URL is not set in .env.' }

$databaseName = ([uri]$databaseUrl).AbsolutePath.TrimStart('/')

# --- Refuse while the API is up --------------------------------------------

Write-Step 'Checking that the API is stopped'
try {
    $null = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/health/live" -TimeoutSec 3 -UseBasicParsing
    throw "The API is still answering on port $port. Stop it first — restoring underneath a running server leaves a mixture of old and new rows."
}
catch [System.Net.WebException] {
    Write-Ok 'Not reachable — good'
}
catch [Microsoft.PowerShell.Commands.HttpResponseException] {
    throw "The API is still answering on port $port. Stop it first."
}

# --- Confirm ---------------------------------------------------------------

if (-not $Force) {
    Write-Host ''
    Write-Host 'This will REPLACE the contents of the live database.' -ForegroundColor Red
    Write-Host "  Database: $databaseName"
    Write-Host "  Backup:   $BackupFile"
    Write-Host "  Taken:    $((Get-Item $BackupFile).LastWriteTime)"
    Write-Host ''
    Write-Host 'Everything created since that time will be gone: accounts, trusted'
    Write-Host 'devices, permission changes, and the audit trail.' -ForegroundColor Yellow
    Write-Host ''
    $typed = Read-Host "Type the database name ($databaseName) to continue"
    if ($typed -ne $databaseName) {
        Write-Host 'Cancelled. Nothing was changed.' -ForegroundColor Yellow
        exit 1
    }
}

# --- Restore ---------------------------------------------------------------

Write-Step 'Restoring'

# --clean --if-exists drops the existing objects first, so the result is the
# backup rather than the backup merged into whatever was there.
& pg_restore --dbname=$databaseUrl --clean --if-exists --no-owner --no-privileges $BackupFile
if ($LASTEXITCODE -ne 0) {
    throw "pg_restore exited with $LASTEXITCODE. The database may be in a partial state — restore again or rebuild from a known-good backup before starting the API."
}

Write-Step 'Applying any migrations newer than the backup'
Push-Location (Join-Path $root 'apps\api')
try {
    & npx prisma migrate deploy
    if ($LASTEXITCODE -ne 0) { throw 'prisma migrate deploy failed.' }
}
finally { Pop-Location }

Write-Host ''
Write-Host 'Restore complete.' -ForegroundColor Green
Write-Host ''
Write-Host 'Before you start the API:' -ForegroundColor Yellow
Write-Host '  * Tell affected people what window was rolled back. An audit trail with'
Write-Host '    a silent gap is worse than one with a documented gap.'
Write-Host '  * Anyone who signed in since the backup will need to sign in again;'
Write-Host '    their refresh tokens are no longer in the database.'
Write-Host '  * Agents keep their own keys and will re-authenticate on their own.'
