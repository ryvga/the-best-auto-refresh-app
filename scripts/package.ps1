$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $projectRoot 'extension'
$distPath = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Force -Path $distPath | Out-Null
$manifest = Get-Content -LiteralPath (Join-Path $sourcePath 'manifest.json') -Raw | ConvertFrom-Json
$zipPath = Join-Path $distPath ("the-best-auto-refresh-app-" + $manifest.version + '.zip')

# The archive is written explicitly instead of with Compress-Archive, because
# Compress-Archive stores Windows separators ("icons\icon16.png"). A ZIP entry
# name is defined to use "/", and an archive with backslashes can be read as a
# single file literally named "icons\icon16.png", which breaks the store upload.
# Both assemblies are required: ZipArchiveMode lives in System.IO.Compression,
# while ZipFile lives in System.IO.Compression.FileSystem.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    Get-ChildItem -LiteralPath $sourcePath -Recurse -File | ForEach-Object {
        $relative = $_.FullName.Substring($sourcePath.Length + 1).Replace('\', '/')
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, $_.FullName, $relative, [System.IO.Compression.CompressionLevel]::Optimal)
    }
}
finally {
    $zip.Dispose()
}

# Fail loudly if the archive is not uploadable, rather than shipping a broken ZIP.
$verify = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    $names = @($verify.Entries | ForEach-Object { $_.FullName })
    if ($names -notcontains 'manifest.json') {
        throw "Packaging failed: manifest.json is not at the archive root."
    }
    if ($names | Where-Object { $_ -like '*\*' }) {
        throw "Packaging failed: archive contains backslash entry names."
    }
    Write-Output "Packaged $($names.Count) files"
}
finally {
    $verify.Dispose()
}

Write-Output $zipPath
