# build-tray.ps1 — 编译 TriLC.Tray.exe（单文件自包含）
# 用法: .\scripts\build-tray.ps1 [-Configuration Release|Debug] [-OutputDir ..\dist]
param(
    [string]$Configuration = "Release",
    [string]$OutputDir = "$PSScriptRoot\..\dist"
)

$ErrorActionPreference = "Stop"
$trayDir = "$PSScriptRoot\..\src\tray"

Write-Host "========================================" -ForegroundColor DarkCyan
Write-Host "  TriLC.Tray — Build Script v1.0.0" -ForegroundColor DarkCyan
Write-Host "========================================" -ForegroundColor DarkCyan
Write-Host ""

# 检查 dotnet SDK
try {
    $dotnetVer = dotnet --version 2>&1
    Write-Host "  .NET SDK: $dotnetVer" -ForegroundColor Gray
} catch {
    Write-Error ".NET SDK 未安装或不在此 PATH 中。请安装 .NET 8.0 SDK: https://dotnet.microsoft.com/download/dotnet/8.0"
    exit 1
}

# ============================================================
# 1. 生成图标
# ============================================================
Write-Host "[1/3] 生成图标资源..." -ForegroundColor Cyan

Add-Type -AssemblyName System.Drawing

$colors = @{
    "tri_green.ico" = "#4CAF50"
    "tri_red.ico"   = "#F44336"
    "tri_gray.ico"  = "#9E9E9E"
}

New-Item -ItemType Directory -Force -Path "$trayDir\Resources" | Out-Null

foreach ($name in $colors.Keys) {
    $hex = $colors[$name]
    $color = [System.Drawing.ColorTranslator]::FromHtml($hex)
    $bmp = New-Object System.Drawing.Bitmap(32, 32)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'

    # 实心圆（2px 边距）
    $brush = New-Object System.Drawing.SolidBrush($color)
    $g.FillEllipse($brush, 3, 3, 26, 26)

    # 外圆描边（加深色）
    $darker = [System.Drawing.Color]::FromArgb(
        [Math]::Max(0, $color.R - 40),
        [Math]::Max(0, $color.G - 40),
        [Math]::Max(0, $color.B - 40))
    $pen = New-Object System.Drawing.Pen($darker, 1.5)
    $g.DrawEllipse($pen, 3, 3, 26, 26)

    # 保存为 .ico
    $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    $outPath = "$trayDir\Resources\$name"
    $fs = [System.IO.File]::Create($outPath)
    $icon.Save($fs)
    $fs.Close()

    # 释放 GDI 资源
    $icon.Dispose(); $pen.Dispose(); $brush.Dispose(); $g.Dispose(); $bmp.Dispose()
    Write-Host "  ✓ $name" -ForegroundColor Green
}

# ============================================================
# 2. 编译
# ============================================================
Write-Host ""
Write-Host "[2/3] 编译 TriLC.Tray.exe..." -ForegroundColor Cyan

$outputAbs = [System.IO.Path]::GetFullPath($OutputDir)
Write-Host "  输出目录: $outputAbs" -ForegroundColor Gray

Push-Location $trayDir
try {
    dotnet publish -c $Configuration -r win-x64 `
        -p:PublishSingleFile=true `
        -p:SelfContained=false `
        -p:PublishTrimmed=false `
        -p:DebugType=none `
        -o "$outputAbs"

    if ($LASTEXITCODE -ne 0) {
        Write-Error "dotnet publish 失败 (exit code: $LASTEXITCODE)"
        Pop-Location
        exit 1
    }
} finally {
    Pop-Location
}

# ============================================================
# 3. 验证
# ============================================================
Write-Host ""
Write-Host "[3/3] 验证..." -ForegroundColor Cyan

$exe = "$outputAbs\TriLC.Tray.exe"
if (Test-Path $exe) {
    $size = [math]::Round((Get-Item $exe).Length / 1KB, 1)
    Write-Host "  ✓ TriLC.Tray.exe ($size KB)" -ForegroundColor Green

    # 大小门禁检查（< 1MB）
    if ($size -ge 1024) {
        Write-Warning "  ⚠ TriLC.Tray.exe 超过 1MB ($size KB)，请检查是否误启用了 SelfContained。"
    }
} else {
    Write-Error "构建失败：未找到 $exe"
    exit 1
}

Write-Host ""
Write-Host "========================================" -ForegroundColor DarkCyan
Write-Host "  构建完成！" -ForegroundColor Green
Write-Host "  输出: $exe" -ForegroundColor Gray
Write-Host "========================================" -ForegroundColor DarkCyan
