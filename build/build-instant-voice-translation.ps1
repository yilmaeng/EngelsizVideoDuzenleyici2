param(
    [Parameter(Mandatory = $true)]
    [string]$Version
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Version) -or $Version -match '^%.*%$') {
    $package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
    $Version = [string]$package.version
}

$builder = Join-Path $projectRoot 'node_modules\.bin\electron-builder.cmd'
$config = Join-Path $PSScriptRoot 'instant-voice-translation-builder.json'
$distDir = Join-Path $projectRoot 'dist'
$unpackedDir = Join-Path $distDir 'win-unpacked'
$folderArtifact = Join-Path $distDir ("Anlik-Sesli-Ceviri-v{0}" -f $Version)

& (Join-Path $PSScriptRoot 'build-native-audio.ps1')
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host "Building instant spoken translation folder distribution..."
& $builder --config $config --win dir --x64
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

if (Test-Path $folderArtifact) {
    Remove-Item -LiteralPath $folderArtifact -Recurse -Force
}
Move-Item -LiteralPath $unpackedDir -Destination $folderArtifact

Write-Host "Instant spoken translation folder artifact is ready:"
Write-Host ("- {0}" -f $folderArtifact)
