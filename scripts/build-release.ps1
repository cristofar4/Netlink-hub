#Requires -Version 5.1
<#
.SYNOPSIS
    Builds the NetLink release artifacts, signs them, and produces a signed
    update manifest.

.DESCRIPTION
    Two separate signatures, doing two different jobs. Conflating them is a
    common and expensive mistake:

    1. AUTHENTICODE, over each binary. This is what stops SmartScreen warning
       users, and what makes the publisher name real in the UAC prompt. It
       needs an EV or OV code-signing certificate from a public CA.

    2. The NETLINK RELEASE SIGNATURE, over the manifest. This is what agents
       actually check before replacing themselves. It is an Ed25519 key that
       belongs to you and is trusted by nothing except NetLink installations.

    Authenticode alone is not enough: an attacker who can serve a *genuine,
    signed, older* release performs a downgrade attack without forging
    anything. The manifest signature is what covers version and hash together.

    This script REFUSES to claim something was signed when it was not. Without
    a certificate it produces unsigned binaries and says so loudly, in the
    output and in the manifest — an unsigned build that is labelled unsigned is
    fine; one that is quietly labelled signed is how a bad build reaches users.

.PARAMETER Version
    Semantic version for this release, e.g. 1.4.0.

.PARAMETER OutputDirectory
    Where to put the artifacts. Default: dist\<version>.

.PARAMETER CertificateThumbprint
    Authenticode certificate in the local certificate store. Omit for an
    unsigned build.

.PARAMETER ReleaseKeyPath
    File holding the base64url Ed25519 seed that signs the manifest. Keep this
    offline; it is the key that decides what runs on every installation.

.PARAMETER BaseUrl
    Where the artifacts will be served from. Must be https.

.EXAMPLE
    .\scripts\build-release.ps1 -Version 1.4.0 -BaseUrl https://releases.example.com

.EXAMPLE
    .\scripts\build-release.ps1 -Version 1.4.0 `
        -CertificateThumbprint A1B2C3... `
        -ReleaseKeyPath E:\keys\netlink-release.key `
        -BaseUrl https://releases.example.com
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$')]
    [string]$Version,

    [string]$OutputDirectory,

    [string]$CertificateThumbprint,

    [string]$ReleaseKeyPath,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https://')]
    [string]$BaseUrl,

    [ValidateSet('stable', 'beta')]
    [string]$Channel = 'stable',

    [int]$ManifestValidDays = 90
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "    $Message" -ForegroundColor Yellow }

if (-not $OutputDirectory) { $OutputDirectory = Join-Path $root "dist\$Version" }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

$signed = $false
$artifacts = @()

# --- The gate --------------------------------------------------------------

Write-Step 'Running the full check suite'
& (Join-Path $PSScriptRoot 'test-all.ps1')
if ($LASTEXITCODE -ne 0) {
    throw 'Checks failed. A release is not built from a tree that does not pass.'
}

# --- Agent -----------------------------------------------------------------

Write-Step "Building the agent $Version"
Push-Location (Join-Path $root 'services\agent')
try {
    $env:GOOS = 'windows'
    $env:GOARCH = 'amd64'
    # Trimpath keeps local directory names out of the binary; the ldflags stamp
    # the version so a running agent can report what it actually is rather than
    # what a config file claims.
    & go build -trimpath -ldflags "-s -w -X main.version=$Version" `
        -o (Join-Path $OutputDirectory 'netlink-agent.exe') .\cmd\netlink-agent
    if ($LASTEXITCODE -ne 0) { throw 'Building the agent failed.' }
}
finally {
    Remove-Item Env:\GOOS -ErrorAction SilentlyContinue
    Remove-Item Env:\GOARCH -ErrorAction SilentlyContinue
    Pop-Location
}
Write-Ok 'netlink-agent.exe'

# --- Desktop ---------------------------------------------------------------

Write-Step "Building the desktop app $Version"
Push-Location (Join-Path $root 'apps\desktop')
try {
    & wails build -platform windows/amd64 -trimpath -clean -ldflags "-X main.version=$Version"
    if ($LASTEXITCODE -ne 0) { throw 'wails build failed.' }
    Copy-Item -Path 'build\bin\NetLink.exe' -Destination (Join-Path $OutputDirectory 'NetLink.exe') -Force
}
finally { Pop-Location }
Write-Ok 'NetLink.exe'

# --- Authenticode ----------------------------------------------------------

$binaries = @('netlink-agent.exe', 'NetLink.exe') | ForEach-Object { Join-Path $OutputDirectory $_ }

if ($CertificateThumbprint) {
    Write-Step 'Signing with Authenticode'

    $signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if (-not $signtool) {
        # The Windows SDK does not put signtool on PATH; look where it lives.
        $candidates = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match 'x64' } | Sort-Object FullName -Descending
        if ($candidates) { $signtool = $candidates[0].FullName }
    }
    if (-not $signtool) {
        throw 'signtool.exe was not found. Install the Windows SDK, or omit -CertificateThumbprint for an unsigned build.'
    }

    foreach ($binary in $binaries) {
        # RFC 3161 timestamping, so the signature stays valid after the
        # certificate expires. Without it every release stops verifying on the
        # certificate's expiry date, which is a self-inflicted outage.
        & $signtool sign /sha1 $CertificateThumbprint /fd SHA256 `
            /tr http://timestamp.digicert.com /td SHA256 /q $binary
        if ($LASTEXITCODE -ne 0) { throw "Signing $binary failed." }

        & $signtool verify /pa /q $binary
        if ($LASTEXITCODE -ne 0) { throw "$binary did not verify after signing." }
        Write-Ok "Signed $(Split-Path -Leaf $binary)"
    }
    $signed = $true
}
else {
    Write-Warn 'NO CODE-SIGNING CERTIFICATE — these binaries are UNSIGNED.'
    Write-Warn 'Windows SmartScreen will warn users, and the UAC prompt will say'
    Write-Warn '"Unknown publisher". Do not ship this to anyone but yourself.'
}

# --- Manifest --------------------------------------------------------------

Write-Step 'Building the update manifest'

foreach ($binary in $binaries) {
    $name = Split-Path -Leaf $binary
    $artifacts += [ordered]@{
        component = if ($name -eq 'netlink-agent.exe') { 'agent' } else { 'desktop' }
        platform  = 'windows/amd64'
        url       = "$($BaseUrl.TrimEnd('/'))/$Version/$name"
        sha256    = (Get-FileHash -Path $binary -Algorithm SHA256).Hash.ToLower()
        bytes     = (Get-Item $binary).Length
    }
}

$now = (Get-Date).ToUniversalTime()
$manifest = [ordered]@{
    version    = $Version
    channel    = $Channel
    releasedAt = $now.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    expiresAt  = $now.AddDays($ManifestValidDays).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    notes      = if ($signed) { '' } else { 'UNSIGNED BUILD — not for distribution' }
    artifacts  = $artifacts
}

$manifestPath = Join-Path $OutputDirectory 'manifest.json'
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestPath -Encoding UTF8

if ($ReleaseKeyPath) {
    if (-not (Test-Path $ReleaseKeyPath)) { throw "No release key at $ReleaseKeyPath." }

    Write-Step 'Signing the update manifest'
    Push-Location (Join-Path $root 'services\agent')
    try {
        & go run .\cmd\netlink-release sign --manifest $manifestPath --key $ReleaseKeyPath `
            --out (Join-Path $OutputDirectory 'manifest.signed.json')
        if ($LASTEXITCODE -ne 0) { throw 'Signing the manifest failed.' }
    }
    finally { Pop-Location }
    Write-Ok 'manifest.signed.json'
}
else {
    Write-Warn 'NO RELEASE KEY — the manifest is UNSIGNED.'
    Write-Warn 'No agent will apply this update: an unsigned manifest is refused,'
    Write-Warn 'which is the correct behaviour and not a bug to work around.'
}

# --- Summary ---------------------------------------------------------------

Write-Host ''
if ($signed -and $ReleaseKeyPath) {
    Write-Host "Release $Version built and signed." -ForegroundColor Green
}
else {
    Write-Host "Release $Version built — NOT READY TO DISTRIBUTE." -ForegroundColor Yellow
    if (-not $signed) { Write-Host '  * binaries are not Authenticode signed' -ForegroundColor Yellow }
    if (-not $ReleaseKeyPath) { Write-Host '  * the update manifest is not signed' -ForegroundColor Yellow }
}
Write-Host "  Output: $OutputDirectory"
Get-ChildItem $OutputDirectory | ForEach-Object {
    Write-Host ("    {0,-24} {1,10:N0} bytes" -f $_.Name, $_.Length)
}
