<#
.SYNOPSIS
  Download the Windows Python embeddable package and stage it into
  client_2/bin/python/<arch>/ so electron-builder's win.extraResources rule
  can copy it into resources/python/ of the packaged app.

.DESCRIPTION
  The Edison Watch session hooks (edison-session-*.py) are spawned by AI agent
  apps (Claude Code, Cursor, VS Code) outside the Electron process and need a
  Python interpreter. macOS/Linux ship one; Windows frequently does not, so we
  bundle the official embeddable build. The hooks are stdlib-only
  (json/os/sys/time/random), so the embeddable package is sufficient - no pip,
  no site-packages.

  Both architectures are staged in a single run because one `electron-builder
  --win` invocation produces both the x64 and arm64 installers; the
  win.extraResources `from: bin/python/${arch}` rule then selects the matching
  interpreter per target arch.

  Why outside resources/: like scripts/build-stdiod.sh stages the daemon into
  bin/, keeping Python under a top-level bin/ directory means it does NOT match
  the default electron-builder `files` glob (resources/**) and so is not
  double-included in the asar. It is picked up only via extraResources.

.NOTES
  Runs on the windows-latest CI runner (pwsh). To build a Windows installer
  from macOS/Linux, install PowerShell 7 (`brew install powershell`).
#>
[CmdletBinding()]
param(
  # Which arch(es) to stage. Default 'all' stages both for a full `--win` build.
  [ValidateSet('all', 'x64', 'arm64')]
  [string]$Arch = 'all',

  # Pinned CPython version. The python.org/ftp archive is immutable, so a
  # versioned URL + SHA256 is the integrity anchor.
  [string]$Version = '3.12.8'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# electron-builder ${arch} value -> embeddable download suffix + expected SHA256.
# Hashes computed from python.org/ftp/python/3.12.8/python-3.12.8-embed-*.zip.
$Targets = @{
  'x64'   = @{ Suffix = 'amd64'; Sha256 = '8D3F33BE9EB810F23C102F08475AF2854E50484B8E4E06275E937BE61CE3D2FB' }
  'arm64' = @{ Suffix = 'arm64'; Sha256 = 'D34DB37675973785A2A539CD1C8DDE1B6D45665F48C615EF55274B3798BF9FD3' }
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ClientDir = Split-Path -Parent $ScriptDir
$OutRoot   = Join-Path $ClientDir 'bin/python'

$archList = if ($Arch -eq 'all') { @('x64', 'arm64') } else { @($Arch) }

foreach ($a in $archList) {
  $spec    = $Targets[$a]
  $destDir = Join-Path $OutRoot $a
  $stamp   = Join-Path $destDir '.staged-version'

  # Skip re-staging if this exact version is already present and intact.
  if ((Test-Path (Join-Path $destDir 'python.exe')) -and
      (Test-Path $stamp) -and
      ((Get-Content $stamp -Raw).Trim() -eq $Version)) {
    Write-Host "[stage-python] $a already staged at $Version - skipping"
    continue
  }

  $url = "https://www.python.org/ftp/python/$Version/python-$Version-embed-$($spec.Suffix).zip"
  $zip = Join-Path ([System.IO.Path]::GetTempPath()) "python-$Version-embed-$($spec.Suffix).zip"

  Write-Host "[stage-python] Downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

  $actual = (Get-FileHash -Path $zip -Algorithm SHA256).Hash
  if ($actual -ne $spec.Sha256) {
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    throw "[stage-python] SHA256 mismatch for $a`n  expected $($spec.Sha256)`n  actual   $actual"
  }
  Write-Host "[stage-python] SHA256 verified for $a"

  if (Test-Path $destDir) { Remove-Item $destDir -Recurse -Force }
  New-Item -ItemType Directory -Path $destDir -Force | Out-Null
  Expand-Archive -Path $zip -DestinationPath $destDir -Force
  Set-Content -Path $stamp -Value $Version -NoNewline

  Write-Host "[stage-python] Staged $a -> $destDir"
}

Write-Host "[stage-python] Done."
