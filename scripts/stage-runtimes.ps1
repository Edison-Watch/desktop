<#
.SYNOPSIS
  Download Node (npx) and uv (uvx) for Windows and stage them into
  client_2/bin/runtimes/<arch>/{node,uv}/ so a win.extraResources rule can copy
  them into the packaged app at resources/runtimes/.

.DESCRIPTION
  The stdiod daemon spawns child MCP servers via `npx` (npm ecosystem) and `uvx`
  (Python ecosystem). Windows users often have neither, so we bundle them. The
  daemon appends resources/runtimes/{node,uv} to each child's PATH as a fallback
  (a system-installed npx/uvx still wins). Both arch's runtimes are staged in one
  run; the win.extraResources `${arch}` macro selects the matching set per
  installer. Runs on pwsh (macOS/Linux for local cross-builds, or windows-latest CI).
#>
[CmdletBinding()]
param(
  [ValidateSet('all', 'x64', 'arm64')]
  [string]$Arch = 'all',
  [string]$NodeVersion = 'v24.16.0',
  [string]$UvVersion = '0.11.21'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# electron-builder ${arch} -> { node zip suffix ; uv release target triple }
$Targets = @{
  'x64'   = @{ Node = 'win-x64'; Uv = 'x86_64-pc-windows-msvc' }
  'arm64' = @{ Node = 'win-arm64'; Uv = 'aarch64-pc-windows-msvc' }
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ClientDir = Split-Path -Parent $ScriptDir
$OutRoot   = Join-Path $ClientDir 'bin/runtimes'
$Tmp       = [System.IO.Path]::GetTempPath()

# Invoke-WebRequest .Content is sometimes Byte[] (no text content-type) - decode.
function Get-TextContent($Uri) {
  $r = Invoke-WebRequest -Uri $Uri -UseBasicParsing
  if ($r.Content -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($r.Content) } else { [string]$r.Content }
}

function Test-Sha256($File, $Expected) {
  $actual = (Get-FileHash -Path $File -Algorithm SHA256).Hash
  if ($actual -ne $Expected) {
    Remove-Item $File -Force -ErrorAction SilentlyContinue
    throw "SHA256 mismatch for $File`n  expected $Expected`n  actual   $actual"
  }
}

$archList = if ($Arch -eq 'all') { @('x64', 'arm64') } else { @($Arch) }

foreach ($a in $archList) {
  $t = $Targets[$a]
  $dest = Join-Path $OutRoot $a

  # ---- Node (npx) ----
  $nodeDir = Join-Path $dest 'node'
  $nodeStamp = Join-Path $nodeDir '.node-version'
  if ((Test-Path (Join-Path $nodeDir 'npx.cmd')) -and (Test-Path $nodeStamp) -and
      ((Get-Content $nodeStamp -Raw).Trim() -eq $NodeVersion)) {
    Write-Host "[stage-runtimes] $a node $NodeVersion already staged - skipping"
  } else {
    $name = "node-$NodeVersion-$($t.Node)"
    $url = "https://nodejs.org/dist/$NodeVersion/$name.zip"
    $zip = Join-Path $Tmp "$name.zip"
    Write-Host "[stage-runtimes] downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    $shas = Get-TextContent "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt"
    $line = ($shas -split "`n" | Where-Object { $_ -match [regex]::Escape("$name.zip") } | Select-Object -First 1)
    if (-not $line) { throw "no SHASUMS entry for $name.zip" }
    Test-Sha256 $zip ($line.Trim() -split '\s+')[0]
    Write-Host "[stage-runtimes] SHA256 verified for node $a"

    $extract = Join-Path $Tmp "node-extract-$a"
    if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $extract -Force
    if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
    New-Item -ItemType Directory -Path $nodeDir -Force | Out-Null
    # The zip wraps everything in a node-<ver>-<arch>/ dir; flatten it.
    Move-Item -Path (Join-Path (Join-Path $extract $name) '*') -Destination $nodeDir
    Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
    Set-Content -Path $nodeStamp -Value $NodeVersion -NoNewline
    Write-Host "[stage-runtimes] staged node -> $nodeDir"
  }

  # ---- uv (uvx) ----
  $uvDir = Join-Path $dest 'uv'
  $uvStamp = Join-Path $uvDir '.uv-version'
  if ((Test-Path (Join-Path $uvDir 'uvx.exe')) -and (Test-Path $uvStamp) -and
      ((Get-Content $uvStamp -Raw).Trim() -eq $UvVersion)) {
    Write-Host "[stage-runtimes] $a uv $UvVersion already staged - skipping"
  } else {
    $asset = "uv-$($t.Uv).zip"
    $url = "https://github.com/astral-sh/uv/releases/download/$UvVersion/$asset"
    $zip = Join-Path $Tmp $asset
    Write-Host "[stage-runtimes] downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    $expected = ((Get-TextContent "$url.sha256").Trim() -split '\s+')[0]
    Test-Sha256 $zip $expected
    Write-Host "[stage-runtimes] SHA256 verified for uv $a"

    if (Test-Path $uvDir) { Remove-Item $uvDir -Recurse -Force }
    New-Item -ItemType Directory -Path $uvDir -Force | Out-Null
    Expand-Archive -Path $zip -DestinationPath $uvDir -Force
    Set-Content -Path $uvStamp -Value $UvVersion -NoNewline
    Write-Host "[stage-runtimes] staged uv -> $uvDir"
  }
}

Write-Host "[stage-runtimes] Done. Runtimes staged under $OutRoot/<arch>/{node,uv}/"
