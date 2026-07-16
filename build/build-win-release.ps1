param(
    [Parameter(Mandatory = $true)]
    [string]$Version
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$builder = Join-Path $projectRoot 'node_modules\.bin\electron-builder.cmd'
$distDir = Join-Path $projectRoot 'dist'
$unpackedDir = Join-Path $distDir 'win-unpacked'
$portableFolder = Join-Path $distDir 'EVD'
$portableExeSource = Join-Path $portableFolder 'Engelsiz Video Düzenleyicisi.exe'
$portableExeTarget = Join-Path $portableFolder 'EVD.exe'
$zipPath = Join-Path $distDir ("EVD-Portable-v{0}.zip" -f $Version)

& (Join-Path $PSScriptRoot 'build-native-audio.ps1')
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host "Building Windows NSIS + dir targets..."
& $builder --win nsis dir --x64
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

if (-not (Test-Path $unpackedDir)) {
    throw "win-unpacked output not found: $unpackedDir"
}

if (Test-Path $portableFolder) {
    Remove-Item $portableFolder -Recurse -Force
}

Write-Host "Preparing portable folder..."
Copy-Item $unpackedDir $portableFolder -Recurse

if (Test-Path $portableExeSource) {
    Rename-Item $portableExeSource 'EVD.exe'
}

if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

Write-Host "Creating portable zip..."
Compress-Archive -Path $portableFolder -DestinationPath $zipPath -CompressionLevel Optimal

Write-Host "Windows release artifacts are ready:"
Write-Host ("- {0}" -f (Join-Path $distDir ("EVD-Setup-v{0}.exe" -f $Version)))
Write-Host ("- {0}" -f $zipPath)
