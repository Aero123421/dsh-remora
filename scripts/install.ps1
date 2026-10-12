<#
.SYNOPSIS
  Install the Remora CLI (remora) on Windows.

.DESCRIPTION
  Two forms, both verified against SHA256SUMS before anything is installed:

    node    remora.mjs (~135 KB) plus a small remora.cmd launcher, used when
            Node.js 22.19 or later is available. The default whenever possible.
    binary  the standalone remora-win32-x64.exe (~100 MB, embeds Node.js) as
            remora.exe, used when Node.js is missing or too old, or with -Form binary.

  Both go to %LOCALAPPDATA%\remora\bin (or $env:REMORA_INSTALL_DIR).
  `remora self-update` keeps whichever form is installed.

    irm https://raw.githubusercontent.com/Aero123421/dsh-remora/main/scripts/install.ps1 | iex

  or, with options:

    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Aero123421/dsh-remora/main/scripts/install.ps1))) -Version v0.2.0 -Form binary -AddToPath

.PARAMETER Version
  Release tag such as v0.2.0. Default: latest ($env:REMORA_VERSION).
.PARAMETER InstallDir
  Target folder. Default: %LOCALAPPDATA%\remora\bin ($env:REMORA_INSTALL_DIR).
.PARAMETER Form
  auto (default), node or binary ($env:REMORA_FORM). $env:REMORA_NODE picks the node to use.
.PARAMETER AddToPath
  Also add the folder to the user PATH.
#>
[CmdletBinding()]
param(
  [string]$Version = $(if ($env:REMORA_VERSION) { $env:REMORA_VERSION } else { 'latest' }),
  [string]$InstallDir = $(if ($env:REMORA_INSTALL_DIR) { $env:REMORA_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'remora\bin' }),
  [ValidateSet('auto', 'node', 'binary')]
  [string]$Form = $(if ($env:REMORA_FORM) { $env:REMORA_FORM } else { 'auto' }),
  [switch]$AddToPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar
# Windows PowerShell 5.1 may default to TLS 1.0.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$repo = if ($env:REMORA_REPO) { $env:REMORA_REPO } else { 'Aero123421/dsh-remora' }
# Must match RELEASE_ASSETS in packages/protocol/src/endpoints.ts.
$scriptAsset = 'remora.mjs'
$sumsAsset = 'SHA256SUMS'

# --- which form ---------------------------------------------------------------
function Find-Node {
  $candidate = $env:REMORA_NODE
  if (-not $candidate) {
    $found = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $candidate = $found.Source }
  }
  if (-not $candidate -or -not (Test-Path -LiteralPath $candidate)) { return $null }
  try { $v = & $candidate -p 'process.versions.node' 2>$null } catch { return $null }
  if ("$v" -match '^(\d+)\.(\d+)') {
    $major = [int]$Matches[1]; $minor = [int]$Matches[2]
    if ($major -gt 22 -or ($major -eq 22 -and $minor -ge 19)) { return $candidate }
  }
  return $null
}

$nodeBin = $null
if ($Form -ne 'binary') {
  $nodeBin = Find-Node
  if (-not $nodeBin) {
    if ($Form -eq 'node') { throw 'remora install: -Form node needs Node.js 22.19 or later (set $env:REMORA_NODE to its path)' }
    Write-Host 'Node.js 22.19 or later was not found: installing the standalone binary.'
    $Form = 'binary'
  } else {
    $Form = 'node'
  }
}

function Get-BinaryAsset {
  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
  switch ($arch) {
    'AMD64' { $cpu = 'x64' }
    'ARM64' { $cpu = 'x64'; Write-Host 'Windows on Arm: installing the x64 build (runs under emulation).' }
    default { throw "remora install: no standalone binary for $arch; install Node.js 22.19+ and use -Form node" }
  }
  # Must match RELEASE_ASSETS.cli in packages/protocol/src/endpoints.ts.
  return "remora-win32-$cpu.exe"
}

# --- download and verify ----------------------------------------------------------
if ($env:REMORA_DOWNLOAD_BASE) {
  $base = $env:REMORA_DOWNLOAD_BASE.TrimEnd('/')
} elseif ($Version -eq 'latest') {
  $base = "https://github.com/$repo/releases/latest/download"
} else {
  $tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
  $base = "https://github.com/$repo/releases/download/$tag"
}

function Get-Checksum([string]$sumsFile, [string]$name) {
  foreach ($line in Get-Content -LiteralPath $sumsFile) {
    $parts = $line.Trim() -split '\s+', 2
    if ($parts.Count -eq 2 -and ($parts[1] -eq $name -or $parts[1] -eq "*$name")) { return $parts[0].ToLowerInvariant() }
  }
  return $null
}

# Put a file in place: stage it next to the target, move a running file aside, then rename.
function Install-File([string]$source, [string]$name) {
  $target = Join-Path $InstallDir $name
  $staged = Join-Path $InstallDir ".$name.new"
  Copy-Item -LiteralPath $source -Destination $staged -Force
  Remove-Aside $name
  Move-Item -LiteralPath $staged -Destination $target -Force
  if (Test-Path -LiteralPath "$target.old") { Remove-Item -LiteralPath "$target.old" -Force -ErrorAction SilentlyContinue }
}

# Remove a file from the install folder; a running remora.exe cannot be deleted but can be renamed.
function Remove-Aside([string]$name) {
  $target = Join-Path $InstallDir $name
  if (-not (Test-Path -LiteralPath $target)) { return }
  $old = "$target.old"
  if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue }
  Move-Item -LiteralPath $target -Destination $old -Force
  Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("remora-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $sumsFile = Join-Path $tmp $sumsAsset
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$sumsAsset" -OutFile $sumsFile

  # Releases before remora.mjs existed only have binaries.
  if ($Form -eq 'node' -and -not (Get-Checksum $sumsFile $scriptAsset)) {
    Write-Host "This release has no ${scriptAsset}: installing the standalone binary instead."
    $Form = 'binary'
  }
  $asset = if ($Form -eq 'node') { $scriptAsset } else { Get-BinaryAsset }

  Write-Host "Downloading $asset ($Version) ..."
  $file = Join-Path $tmp $asset
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $file
  $expected = Get-Checksum $sumsFile $asset
  if (-not $expected) { throw "remora install: $sumsAsset has no entry for $asset" }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "remora install: checksum mismatch for $asset (expected $expected, got $actual); nothing was installed" }
  Write-Host "SHA-256 verified: $actual"

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  if ($Form -eq 'node') {
    # cmd.exe reads batch files in the console code page: record the node path
    # only when it is plain ASCII without % or quotes; otherwise use node on PATH.
    $recorded = if ($nodeBin -match '^[\x20-\x7e]+$' -and $nodeBin -notmatch '[%"]') { $nodeBin } else { $null }
    $launcher = @(
      '@echo off',
      "rem remora launcher, written by Remora's install.ps1. Runs remora.mjs with Node.js 22.19+:",
      'rem %REMORA_NODE%, else the node found at install time, else node on PATH.',
      'setlocal',
      'set "REMORA_NODE_EXE=%REMORA_NODE%"'
    )
    if ($recorded) { $launcher += "if not defined REMORA_NODE_EXE if exist `"$recorded`" set `"REMORA_NODE_EXE=$recorded`"" }
    $launcher += @(
      'if not defined REMORA_NODE_EXE set "REMORA_NODE_EXE=node"',
      '"%REMORA_NODE_EXE%" "%~dp0remora.mjs" %*',
      'exit /b %ERRORLEVEL%'
    )
    $cmdFile = Join-Path $tmp 'remora.cmd'
    Set-Content -LiteralPath $cmdFile -Value $launcher -Encoding ASCII
    Install-File $file $scriptAsset
    Install-File $cmdFile 'remora.cmd'
    # remora.exe would win over remora.cmd in PATHEXT order.
    Remove-Aside 'remora.exe'
    $target = Join-Path $InstallDir 'remora.cmd'
    $installed = & $target --version 2>$null
    Write-Host "Installed: $target (Node.js form, $installed, using $nodeBin)"
  } else {
    Install-File $file 'remora.exe'
    Remove-Aside 'remora.cmd'
    Remove-Aside $scriptAsset
    $target = Join-Path $InstallDir 'remora.exe'
    $installed = & $target --version 2>$null
    Write-Host "Installed: $target (standalone binary, $installed)"
  }
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$onPath = ($env:Path -split ';') -contains $InstallDir -or (($userPath -split ';') -contains $InstallDir)
if (-not $onPath) {
  if ($AddToPath) {
    $newPath = if ($userPath) { "$userPath;$InstallDir" } else { $InstallDir }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    $env:Path = "$env:Path;$InstallDir"
    Write-Host "Added $InstallDir to your user PATH (open a new terminal to use it)."
  } else {
    Write-Host ''
    Write-Host "$InstallDir is not on your PATH. Add it with:"
    Write-Host "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';$InstallDir', 'User')"
    Write-Host 'or re-run this installer with -AddToPath.'
  }
}
if ($Form -eq 'node') {
  Write-Host 'MCP clients that start commands without a shell need: cmd /c remora mcp'
}
Write-Host 'Next: remora login https://<your-hub>'
