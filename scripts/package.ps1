$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $projectRoot 'extension'
$distPath = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Force -Path $distPath | Out-Null
$manifest = Get-Content -LiteralPath (Join-Path $sourcePath 'manifest.json') -Raw | ConvertFrom-Json
$zipPath = Join-Path $distPath ("the-best-auto-refresh-app-" + $manifest.version + '.zip')
Compress-Archive -Path (Join-Path $sourcePath '*') -DestinationPath $zipPath -Force
Write-Output $zipPath
