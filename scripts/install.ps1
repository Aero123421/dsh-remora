<#
.SYNOPSIS
  Install the Remora CLI (remora.exe) on Windows.

.DESCRIPTION
  Downloads remora-win32-x64.exe and SHA256SUMS from GitHub Releases (latest by
  default), verifies the SHA-256, and installs it as remora.exe in
  %LOCALAPPDATA%\remora\bin (or $env:REMORA_INSTALL_DIR). Nothing is installed
  when verification fails.

    irm https://raw.githubusercontent.com/Aero123421/dsh-remora/main/scripts/install.ps1 | iex

  or, with options:

    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Aero123421/dsh-remora/main/scripts/install.ps1))) -Version v0.1.0 -AddToPath

.PARAMETER Version
  Release tag such as v0.1.0. Default: latest ($env:REMORA_VERSION).
.PARAMETER InstallDir
  Target folder. Default: %LOCALAPPDATA%\remora\bin ($env:REMORA_INSTALL_DIR).
.PARAMETER AddToPath
  Also add the folder to the user PATH.
#>
[CmdletBinding()]
param(
  [string]$Version = $(if ($env:REMORA_VERSION) { $env:REMORA_VERSION } else { 'latest' }),
  [string]$InstallDir = $(if ($env:REMORA_INSTALL_DIR) { $env:REMORA_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'remora\bin' }),
  [switch]$AddToPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar
# Windows PowerShell 5.1 may default to TLS 1.0.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$repo = if ($env:REMORA_REPO) { $env:REMORA_REPO } else { 'Aero123421/dsh-remora' }

$arch = $env:PROCESSOR_ARCHITECTURE
if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
switch ($arch) {
  'AMD64' { $cpu = 'x64' }
  'ARM64' { $cpu = 'x64'; Write-Host 'Windows on Arm: installing the x64 build (runs under emulation).' }
  default { throw "remora install: unsupported CPU architecture: $arch" }
}
$asset = "remora-win32-$cpu.exe"

if ($env:REMORA_DOWNLOAD_BASE) {
  $base = $env:REMORA_DOWNLOAD_BASE.TrimEnd('/')
} elseif ($Version -eq 'latest') {
  $base = "https://github.com/$repo/releases/latest/download"
} else {
  $tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
  $base = "https://github.com/$repo/releases/download/$tag"
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("remora-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading $asset ($Version) ..."
  $sumsFile = Join-Path $tmp 'SHA256SUMS'
  $binFile = Join-Path $tmp $asset
  Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sumsFile
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $binFile

  $expected = $null
  foreach ($line in Get-Content -LiteralPath $sumsFile) {
    $parts = $line.Trim() -split '\s+', 2
    if ($parts.Count -eq 2 -and ($parts[1] -eq $asset -or $parts[1] -eq "*$asset")) { $expected = $parts[0].ToLowerInvariant(); break }
  }
  if (-not $expected) { throw "remora install: SHA256SUMS has no entry for $asset" }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $binFile).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "remora install: checksum mismatch for $asset (expected $expected, got $actual); nothing was installed" }
  Write-Host "SHA-256 verified: $actual"

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $target = Join-Path $InstallDir 'remora.exe'
  $staged = Join-Path $InstallDir '.remora.new.exe'
  Copy-Item -LiteralPath $binFile -Destination $staged -Force
  if (Test-Path -LiteralPath $target) {
    # A running remora.exe cannot be overwritten, but it can be renamed.
    $old = "$target.old"
    if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue }
    Move-Item -LiteralPath $target -Destination $old -Force
  }
  Move-Item -LiteralPath $staged -Destination $target -Force
  if (Test-Path -LiteralPath "$target.old") { Remove-Item -LiteralPath "$target.old" -Force -ErrorAction SilentlyContinue }
  $installed = & $target --version 2>$null
  Write-Host "Installed: $target ($installed)"
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
Write-Host 'Next: remora login https://<your-hub>'
