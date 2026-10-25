param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$outputDir = Join-Path $projectRoot 'target/local-windows'
$toolsDir = Join-Path $projectRoot 'target/local-windows-tools'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'

if (-not (Test-Path -LiteralPath $vswhere)) {
    throw 'Install Visual Studio 2022 with Desktop development with C++ first.'
}
$vsPath = & $vswhere -version '[17.0,18.0)' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsPath) { throw 'Visual Studio 2022 C++ build tools were not found.' }

# Import the compiler/Windows SDK environment into this process only.
$devShell = Join-Path $vsPath 'Common7/Tools/Microsoft.VisualStudio.DevShell.dll'
Import-Module $devShell
Enter-VsDevShell -VsInstallPath $vsPath -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null

$vsInstallations = & $vswhere -products '*' -property installationPath
$cmake = $vsInstallations | ForEach-Object {
    Join-Path $_ 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
} | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$cargoBin = Join-Path $env:USERPROFILE '.cargo/bin'
$extraPaths = @($cargoBin, (Join-Path $env:LOCALAPPDATA 'bin/NASM'), [Environment]::GetEnvironmentVariable('Path', 'User'), [Environment]::GetEnvironmentVariable('Path', 'Machine'))
if ($cmake) { $extraPaths += Split-Path -Parent $cmake }
$env:PATH = ($extraPaths -join ';') + ';' + $env:PATH
$env:CMAKE_GENERATOR = 'Visual Studio 17 2022'
$env:TAURI_LAP_VC_RUNTIME_MIN_VERSION = $env:VCToolsVersion.Trim()

foreach ($command in @('cargo', 'cmake', 'nasm', 'npm', 'node')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Missing build dependency: $command" }
}

Push-Location $projectRoot
try {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
    & git submodule update --init --recursive
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialize native-library submodules.' }

    if (-not (Test-Path -LiteralPath 'src-vite/node_modules/vite')) {
        & pnpm --dir src-vite install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw 'Could not install frontend dependencies.' }
    }
    if (-not (Test-Path -LiteralPath 'src-tauri/resources/models/vision_model.onnx')) {
        & "$PSScriptRoot/download_models.ps1"
    }
    if (-not (Test-Path -LiteralPath 'src-tauri/resources/ffmpeg/ffmpeg-x86_64-pc-windows-msvc.exe')) {
        & "$PSScriptRoot/download_ffmpeg_sidecar.ps1" -Arch x64
    }

    $tauri = Join-Path $toolsDir 'node_modules/@tauri-apps/cli/tauri.js'
    if (-not (Test-Path -LiteralPath $tauri)) {
        & npm install --prefix $toolsDir --no-save --no-package-lock --no-audit --no-fund '@tauri-apps/cli@2.12.0'
        if ($LASTEXITCODE -ne 0) { throw 'Could not install the Tauri build CLI.' }
    }
    Push-Location (Join-Path $projectRoot 'src-vite')
    try {
        & node 'node_modules/vite/bin/vite.js' build
        if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    }
    finally { Pop-Location }

    # A local installer needs no upstream updater signing key. Keep source
    # configuration unchanged and use the normal release data directory.
    $overridePath = Join-Path $outputDir 'tauri-local.conf.json'
    @{
        build = @{ beforeBuildCommand = '' }
        bundle = @{ createUpdaterArtifacts = $false }
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $overridePath -Encoding utf8

    $logPath = Join-Path $outputDir 'build.log'
    $ErrorActionPreference = 'Continue'
    & node $tauri build --bundles msi --config $overridePath 2>&1 | Tee-Object -FilePath $logPath
    $buildExitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($buildExitCode -ne 0) { throw "Build failed. See $logPath" }

    $installer = Get-ChildItem -LiteralPath 'src-tauri/target/release/bundle/msi' -Filter '*.msi' |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $installer) { throw 'The build did not produce an MSI installer.' }
    Write-Host "Installer: $($installer.FullName)"
}
finally {
    Pop-Location
}
