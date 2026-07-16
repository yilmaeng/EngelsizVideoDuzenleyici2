param()

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$helperProject = Join-Path $projectRoot 'tools\EvdProcessLoopbackCapture\EvdProcessLoopbackCapture.csproj'
$publishDir = Join-Path $projectRoot 'tools\EvdProcessLoopbackCapture\bin\Release\net8.0-windows\win-x64\publish'

if (-not (Test-Path $helperProject)) {
    throw "Native audio helper project not found: $helperProject"
}

Write-Host "Building native audio helper..."
& dotnet publish $helperProject -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o $publishDir
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$helperExe = Join-Path $publishDir 'EvdProcessLoopbackCapture.exe'
if (-not (Test-Path $helperExe)) {
    throw "Native audio helper output not found: $helperExe"
}

Write-Host "Native audio helper is ready:"
Write-Host ("- {0}" -f $helperExe)
