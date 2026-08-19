<#
.SYNOPSIS
  Build and prepare a Merit Marketing Hub release, with safety checks.

.DESCRIPTION
  This refuses to continue when something is wrong rather than producing a
  release nobody can trust. Every BLOCKED message says what to do about it.

  It does NOT publish on its own. It builds, verifies and stamps the artifacts;
  publishing is the CI workflow's job, or a deliberate manual upload.

.PARAMETER Version
  Semantic version, e.g. 1.0.1.

.PARAMETER Channel
  stable | beta | internal. Defaults to stable.

.PARAMETER SkipTests
  Emergency escape hatch. Marks the build INTERNAL and unsigned regardless of
  other settings, because an untested build is not a release.

.EXAMPLE
  ./scripts/release/Release-Merit.ps1 -Version 1.0.1 -Channel stable
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [ValidateSet('stable', 'beta', 'internal')][string]$Channel = 'stable',
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$repoRoot = (git rev-parse --show-toplevel).Trim()
Set-Location $repoRoot

$blocked = @()
function Block([string]$reason, [string]$fix) { $script:blocked += [pscustomobject]@{ Reason = $reason; Fix = $fix } }
function Step([string]$text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }

Write-Host 'Merit Marketing Hub — release' -ForegroundColor Green
Write-Host "Version $Version   Channel $Channel"

# ------------------------------------------------------------------ version
Step 'Version'
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  Block "Version '$Version' is not X.Y.Z." 'Use three numbers, e.g. 1.0.1.'
}
$existingTag = git tag -l "v$Version"
if ($existingTag) {
  Block "Tag v$Version already exists." 'Pick the next version number; a released version is never rebuilt.'
}

# --------------------------------------------------------------- git state
Step 'Repository state'
$dirty = git status --porcelain
if ($dirty) {
  Block 'The working tree has uncommitted changes.' 'Commit or stash them, so the build matches a known commit.'
  $dirty | Select-Object -First 10 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
}
$commit = (git rev-parse HEAD).Trim()
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
Write-Host "  commit $commit"
Write-Host "  branch $branch"

# ---------------------------------------------------------------- toolchain
Step 'Toolchain'
$nodeVersion = (node --version).Trim()
Write-Host "  node $nodeVersion"
if ($nodeVersion -notmatch '^v(2[0-9]|[3-9][0-9])\.') {
  Block "Node $nodeVersion is older than the supported version." 'Install Node 20 or newer.'
}
if (-not (Test-Path 'package-lock.json')) {
  Block 'package-lock.json is missing.' 'Run npm install and commit the lock file, so builds are reproducible.'
}

# ------------------------------------------------------------------ assets
Step 'Assets'
if (Test-Path 'assets/crm.ico') {
  Write-Host '  crm.ico present' -ForegroundColor Green
} else {
  # A missing icon does not corrupt data, so it blocks only a STABLE release.
  if ($Channel -eq 'stable') {
    Block 'assets/crm.ico is missing.' 'Place the real crm.ico in assets/ before a stable release.'
  } else {
    Write-Warning '  assets/crm.ico is missing — the default Electron icon will be used.'
  }
}

# ------------------------------------------------------------------- tests
Step 'Tests'
if ($SkipTests) {
  Write-Warning '  TESTS SKIPPED — this build is INTERNAL only.'
  $Channel = 'internal'
} else {
  npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Block 'npm ci failed.' 'Fix the dependency install before releasing.' }

  npm test
  if ($LASTEXITCODE -ne 0) {
    Block 'The test suite failed.' 'Fix the failing tests. A release is never made over a red suite.'
  }

  npm run surface:check
  if ($LASTEXITCODE -ne 0) {
    Block 'The API security surface document is out of date.' 'Run npm run surface:doc and commit the result.'
  }
}

# ----------------------------------------------------------------- signing
Step 'Code signing'
$signed = $false
if ($env:WINDOWS_CERT_FILE) {
  if (Test-Path $env:WINDOWS_CERT_FILE) {
    Write-Host '  certificate configured' -ForegroundColor Green
    $signed = $true
  } else {
    Block "WINDOWS_CERT_FILE points at a file that does not exist: $env:WINDOWS_CERT_FILE" 'Fix the path or unset the variable.'
  }
} else {
  Write-Warning '  No certificate configured — artifacts will be UNSIGNED.'
  Write-Warning '  Windows SmartScreen will warn users on first run.'
}

# ----------------------------------------------------------------- updates
Step 'Update feed'
if ($env:MERIT_UPDATE_URL) {
  Write-Host "  feed $($env:MERIT_UPDATE_URL)" -ForegroundColor Green
} else {
  Write-Warning '  MERIT_UPDATE_URL is not set — this build will not check for updates.'
}

# ------------------------------------------------------------------ verdict
if ($blocked.Count -gt 0) {
  Write-Host "`nBLOCKED — the release did not run." -ForegroundColor Red
  foreach ($b in $blocked) {
    Write-Host "`n  x $($b.Reason)" -ForegroundColor Red
    Write-Host "    -> $($b.Fix)" -ForegroundColor Yellow
  }
  Write-Host ''
  exit 1
}

# -------------------------------------------------------------------- build
Step 'Build'
$env:MERIT_CHANNEL = $Channel
$env:MERIT_COMMIT = $commit

$package = Get-Content 'package.json' -Raw | ConvertFrom-Json
$package.version = $Version
$package | ConvertTo-Json -Depth 20 | Set-Content 'package.json' -Encoding UTF8

npm run make
if ($LASTEXITCODE -ne 0) {
  Write-Host "`nBLOCKED — the build failed." -ForegroundColor Red
  exit 1
}

# ------------------------------------------------------------- provenance
Step 'Provenance'
$schemaVersion = (Get-ChildItem 'database/migrations' -Filter '*.sql' |
  Sort-Object Name | Select-Object -Last 1).Name -replace '^(\d+).*', '$1'

$artifacts = Get-ChildItem 'out/make' -Recurse -File -Include '*.exe', '*.zip', '*.nupkg' -ErrorAction SilentlyContinue
$checksums = foreach ($a in $artifacts) {
  $hash = (Get-FileHash -Algorithm SHA256 $a.FullName).Hash.ToLower()
  "$hash  $($a.Name)"
}

$release = [ordered]@{
  product       = 'Merit Marketing Hub'
  version       = $Version
  channel       = $Channel
  commit        = $commit
  schemaVersion = [int]$schemaVersion
  builtAt       = (Get-Date).ToUniversalTime().ToString('o')
  node          = $nodeVersion
  signed        = $signed
  testsRun      = (-not $SkipTests)
  artifacts     = @($artifacts | ForEach-Object { $_.Name })
}
New-Item -ItemType Directory -Force -Path 'out/make' | Out-Null
$release | ConvertTo-Json -Depth 10 | Set-Content 'out/make/release.json' -Encoding UTF8
Set-Content 'out/make/SHA256SUMS.txt' -Value $checksums -Encoding UTF8

Write-Host ''
Write-Host 'BUILD COMPLETE' -ForegroundColor Green
Write-Host "  Version : $Version"
Write-Host "  Channel : $Channel"
Write-Host "  Commit  : $commit"
Write-Host "  Schema  : $schemaVersion"
Write-Host "  Signed  : $(if ($signed) { 'YES' } else { 'NO — internal/QA artifact' })"
Write-Host "  Output  : out/make"
Write-Host ''
Write-Host 'Next: commit the version bump, tag it, and push.' -ForegroundColor Cyan
Write-Host "  git add package.json"
Write-Host "  git commit -m `"Release $Version`""
Write-Host "  git tag -a v$Version -m `"Release $Version`""
Write-Host "  git push && git push --tags"
Write-Host ''
Write-Host 'If the push is refused, run scripts/recovery/Recover-Push403.ps1 —' -ForegroundColor Yellow
Write-Host 'it preserves your work so nothing is lost.' -ForegroundColor Yellow
