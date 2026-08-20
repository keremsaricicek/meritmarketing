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
# Both are owner-supplied artwork. Neither is invented here, and a stable
# release cannot proceed without them: shipping the default Electron icon or a
# broken brand mark is a visible defect on the first screen the owner sees.
$requiredAssets = @(
  @{ Path = 'assets/crm.ico';         What = 'the Windows application icon';
     Missing = 'The Windows build would use the default Electron icon.' },
  @{ Path = 'src/renderer/logo.png';  What = 'the in-app brand mark';
     Missing = 'The renderer references ./logo.png; without it the brand mark falls back to the letter mark.' }
)
foreach ($asset in $requiredAssets) {
  if (Test-Path $asset.Path) {
    Write-Host "  $($asset.Path) present" -ForegroundColor Green
  } elseif ($Channel -eq 'stable') {
    Block "$($asset.Path) is missing." "Place $($asset.What) at $($asset.Path) before a stable release."
  } else {
    Write-Warning "  $($asset.Path) is missing — $($asset.Missing)"
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

  # Package first, so the packaged-hygiene suite has a real archive to inspect.
  # It fails without one — the check that nothing dangerous ships must never be
  # able to pass by having looked at nothing.
  npm run package
  if ($LASTEXITCODE -ne 0) { Block 'Packaging failed.' 'The hygiene suite cannot inspect what was not built.' }

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
# `$signed` is set LATER, from the artifacts themselves. A certificate sitting
# on disk is a configuration, not a signature: recording signed:true because the
# variable is set would put a claim in release.json that nobody verified, which
# is exactly the kind of statement this file exists to avoid making.
$certConfigured = $false
if ($env:WINDOWS_CERT_FILE) {
  if (Test-Path $env:WINDOWS_CERT_FILE) {
    Write-Host '  certificate configured — signatures will be verified after the build' -ForegroundColor Green
    $certConfigured = $true
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

New-Item -ItemType Directory -Force -Path 'out/make' | Out-Null
$artifacts = Get-ChildItem 'out/make' -Recurse -File -Include '*.exe', '*.zip', '*.nupkg' -ErrorAction SilentlyContinue
if (-not $artifacts) {
  Block 'No artifacts were produced in out/make.' 'The build did not emit anything to publish.'
}

# Ask Windows whether each executable is ACTUALLY signed. Only every signable
# artifact carrying a Valid signature earns signed:true. A .zip cannot be
# Authenticode-signed at all, so it is reported separately rather than being
# quietly covered by a flag it never satisfied.
$signable = $artifacts | Where-Object { $_.Extension -in '.exe', '.nupkg' }
$signatureReport = foreach ($a in $signable) {
  $sig = Get-AuthenticodeSignature -FilePath $a.FullName
  [ordered]@{ artifact = $a.Name; status = $sig.Status.ToString(); signer = $sig.SignerCertificate.Subject }
}
$signed = ($signable.Count -gt 0) -and
          (@($signatureReport | Where-Object { $_.status -ne 'Valid' }).Count -eq 0)

if ($certConfigured -and -not $signed) {
  Block 'A certificate was configured but the artifacts are not validly signed.' (
    'Signature status: ' + (($signatureReport | ForEach-Object { "$($_.artifact)=$($_.status)" }) -join ', '))
}

# UNSIGNED = INTERNAL / QA ONLY. STABLE = A VALID SIGNATURE, ALWAYS.
#
# This check has to be here — AFTER the artifacts exist and Windows has been
# asked about them — and BEFORE release.json is written or BUILD COMPLETE is
# printed. Previously a stable build with no certificate configured at all
# simply warned and carried on to a successful exit, which meant the honest
# `signed:false` was recorded on an artifact the script had just called a
# stable release. A warning is not a gate.
if ($Channel -eq 'stable' -and -not $signed) {
  $why = if (-not $certConfigured) {
    'No signing certificate is configured (set WINDOWS_CERT_FILE and WINDOWS_CERT_PASSWORD).'
  } elseif ($signable.Count -eq 0) {
    'No signable artifact (.exe/.nupkg) was produced.'
  } else {
    'Signature status: ' + (($signatureReport | ForEach-Object { "$($_.artifact)=$($_.status)" }) -join ', ')
  }
  Block 'A stable release requires validly signed artifacts.' (
    "$why`n`nBuild with -Channel internal for an unsigned QA artifact.")
}
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
  signatures    = @($signatureReport)
  unsignedArtifacts = @($artifacts | Where-Object { $_.Extension -notin '.exe', '.nupkg' } | ForEach-Object { $_.Name })
  testsRun      = (-not $SkipTests)
  artifacts     = @($artifacts | ForEach-Object { $_.Name })
}
$release | ConvertTo-Json -Depth 10 | Set-Content 'out/make/release.json' -Encoding UTF8
Set-Content 'out/make/SHA256SUMS.txt' -Value $checksums -Encoding UTF8

Write-Host ''
Write-Host 'BUILD COMPLETE' -ForegroundColor Green
Write-Host "  Version : $Version"
Write-Host "  Channel : $Channel"
Write-Host "  Commit  : $commit"
Write-Host "  Schema  : $schemaVersion"
Write-Host "  Signed  : $(if ($signed) { 'YES — verified with Get-AuthenticodeSignature' } else { 'NO — internal/QA artifact' })"
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
