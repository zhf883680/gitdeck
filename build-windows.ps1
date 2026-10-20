# 在 Windows 上打包 gitdeck
# 用法：右键「使用 PowerShell 运行」，或  powershell -ExecutionPolicy Bypass -File build-windows.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "== 环境检查 ==" -ForegroundColor Cyan
foreach ($cmd in @("node", "npm", "cargo", "git")) {
  $p = Get-Command $cmd -ErrorAction SilentlyContinue
  if (-not $p) {
    Write-Host "缺少 $cmd，请先安装。" -ForegroundColor Red
    if ($cmd -eq "cargo") { Write-Host "  Rust: https://rustup.rs (需要 MSVC 工具链 + Visual Studio Build Tools 的 C++ 桌面开发组件)" }
    if ($cmd -eq "node")  { Write-Host "  Node: https://nodejs.org (18+)" }
    if ($cmd -eq "git")   { Write-Host "  Git:  https://git-scm.com/download/win" }
    exit 1
  }
  Write-Host ("  {0,-6} {1}" -f $cmd, (& $cmd --version 2>&1 | Select-Object -First 1))
}

Write-Host "`n== 安装构建依赖 ==" -ForegroundColor Cyan
if (-not (Test-Path "node_modules")) { npm install } else { Write-Host "  已存在 node_modules，跳过" }

Write-Host "`n== 打包（首次会下载 Rust 依赖，可能需要 5-15 分钟）==" -ForegroundColor Cyan
npm run app:build

Write-Host "`n== 完成 ==" -ForegroundColor Green
$rel = "src-tauri\target\release"
if (Test-Path "$rel\bundle") {
  Get-ChildItem "$rel\bundle" -Recurse -Include *.exe, *.msi | ForEach-Object {
    Write-Host ("  {0}  ({1:N1} MB)" -f $_.FullName, ($_.Length / 1MB))
  }
  Write-Host "`n便携版单文件：$rel\gitdeck.exe"
} else {
  Write-Host "未找到产物，请检查上方日志。" -ForegroundColor Yellow
}
