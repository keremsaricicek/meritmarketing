<#
.SYNOPSIS
  Preserve committed work when `git push` is refused.

.DESCRIPTION
  A push can fail for reasons that have nothing to do with the code: an expired
  token, a permission change, a policy that allows branches but not tags. That
  happened during this migration — branch pushes succeeded while tag pushes
  returned HTTP 403.

  Nothing is ever reset or discarded here. The commits stay exactly where they
  are; this only writes a copy that can be carried to a machine with working
  credentials.

  Produces:
    recovery/merit-recovery-<commit>.bundle   a complete git bundle
    recovery/patches/*.patch                  the same commits as a patch series
    recovery/manifest.txt                     what is inside and how to use it
    recovery/SHA256SUMS.txt                   checksums for every file above

.PARAMETER Base
  The upstream ref the bundle is measured against. Defaults to the tracked
  remote branch, falling back to origin/main.

.EXAMPLE
  ./scripts/recovery/Recover-Push403.ps1
#>

[CmdletBinding()]
param(
  [string]$Base = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = (git rev-parse --show-toplevel).Trim()
Set-Location $repoRoot

$branch = (git rev-parse --abbrev-ref HEAD).Trim()
$commit = (git rev-parse HEAD).Trim()
$shortCommit = $commit.Substring(0, 12)

if (-not $Base) {
  $tracked = (git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null)
  $Base = if ($LASTEXITCODE -eq 0 -and $tracked) { $tracked.Trim() } else { 'origin/main' }
}

# A dirty tree means there is work that is not in any commit, and a bundle only
# carries commits. Say so rather than producing an incomplete rescue.
$dirty = git status --porcelain
if ($dirty) {
  Write-Warning 'The working tree has uncommitted changes. They will NOT be in the bundle.'
  Write-Warning 'Commit them first if they matter:'
  $dirty | Select-Object -First 20 | ForEach-Object { Write-Warning "  $_" }
}

$recoveryDir = Join-Path $repoRoot 'recovery'
$patchDir = Join-Path $recoveryDir 'patches'
New-Item -ItemType Directory -Force -Path $patchDir | Out-Null

$bundleName = "merit-recovery-$shortCommit.bundle"
$bundlePath = Join-Path $recoveryDir $bundleName

Write-Host "Branch : $branch"
Write-Host "Commit : $commit"
Write-Host "Base   : $Base"

# If the base is unknown locally, bundle the whole branch rather than failing.
git rev-parse --verify $Base *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Warning "$Base is not known locally; bundling the entire branch instead."
  git bundle create $bundlePath $branch
  $range = $branch
} else {
  git bundle create $bundlePath "$Base..$branch" $branch
  $range = "$Base..$branch"
}

Get-ChildItem $patchDir -Filter '*.patch' | Remove-Item -Force
git format-patch $range -o $patchDir | Out-Null
$patches = Get-ChildItem $patchDir -Filter '*.patch'

$commitList = git log --oneline $range
$changed = git diff --stat $range

$manifest = @"
Merit Marketing Hub — push recovery bundle
==========================================
Created   : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
Repository: $repoRoot
Branch    : $branch
Commit    : $commit
Base      : $Base
Patches   : $($patches.Count)

COMMITS
-------
$commitList

FILES CHANGED
-------------
$changed

HOW TO PUSH THIS FROM A MACHINE THAT CAN AUTHENTICATE
-----------------------------------------------------
Option A — the bundle (keeps history exactly):

    git clone <your-repo-url> merit
    cd merit
    git fetch ../$bundleName '$($branch):$($branch)-recovered'
    git checkout $($branch)-recovered
    git push -u origin $branch

Option B — the patch series (when the bundle will not apply):

    git checkout $branch
    git am ../recovery/patches/*.patch
    git push -u origin $branch

Option C — GitHub Desktop, for a non-technical operator:
    1. Open GitHub Desktop and sign in.
    2. File > Clone repository, and choose this repository.
    3. Copy this whole `recovery` folder next to the clone.
    4. Send both to whoever maintains the repository, with this file.

VERIFY BEFORE TRUSTING
----------------------
    Get-FileHash -Algorithm SHA256 $bundleName
and compare against SHA256SUMS.txt.
"@

Set-Content -Path (Join-Path $recoveryDir 'manifest.txt') -Value $manifest -Encoding UTF8

$sums = Get-ChildItem -Path $recoveryDir -Recurse -File |
  Where-Object { $_.Name -ne 'SHA256SUMS.txt' } |
  ForEach-Object {
    $hash = (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLower()
    $relative = $_.FullName.Substring($recoveryDir.Length + 1).Replace('\', '/')
    "$hash  $relative"
  }
Set-Content -Path (Join-Path $recoveryDir 'SHA256SUMS.txt') -Value $sums -Encoding UTF8

Write-Host ''
Write-Host 'Recovery written to:' -ForegroundColor Green
Write-Host "  $bundlePath"
Write-Host "  $patchDir ($($patches.Count) patches)"
Write-Host "  $(Join-Path $recoveryDir 'manifest.txt')"
Write-Host "  $(Join-Path $recoveryDir 'SHA256SUMS.txt')"
Write-Host ''
Write-Host 'Nothing was reset. Your commits are still on this machine.' -ForegroundColor Green
