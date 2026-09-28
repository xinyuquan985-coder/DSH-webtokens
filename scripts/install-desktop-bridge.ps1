# DSH Desktop 桥接插件一键安装脚本
# 用法：在 DSH Desktop 安装并至少启动过一次之后，完全退出 DSH Desktop，然后执行：
#   powershell -ExecutionPolicy Bypass -File scripts\install-desktop-bridge.ps1
# 可选参数：
#   -Tgz <路径>   使用指定的 tgz 包（默认自动在仓库根 npm pack 生成）
#   -ProfileDir <路径> 指定桌面版 profile 目录（默认自动探测）

param(
    [string]$Tgz = "",
    [string]$ProfileDir = ""
)
$ErrorActionPreference = "Continue"
$repo = Split-Path -Parent $PSScriptRoot

# 1. 定位桌面版 profile
if (-not $ProfileDir) {
    $ProfileDir = Join-Path $env:APPDATA "dsh-desktop\harness\profiles\web"
}
if (-not (Test-Path (Join-Path $ProfileDir "package.json"))) {
    throw "未找到桌面版 profile：$ProfileDir`n请先安装 DSH Desktop 并启动过一次（生成 profile），完全退出后再运行本脚本。也可用 -ProfileDir 显式指定。"
}
$nodeCmd = Join-Path $env:APPDATA "dsh-desktop\harness\.desktop-bin\node.cmd"
$pnpmCmd = Join-Path $env:APPDATA "dsh-desktop\harness\.desktop-bin\pnpm.cmd"
if (-not (Test-Path $nodeCmd) -or -not (Test-Path $pnpmCmd)) {
    throw "未找到桌面版自带的 node/pnpm（$nodeCmd）。请确保 DSH Desktop 启动过至少一次。"
}
Write-Host "[1/5] profile: $ProfileDir"

# 2. 准备安装包
if (-not $Tgz) {
    Write-Host "[2/5] 打包插件（npm pack）..."
    Push-Location $repo
    $Tgz = (cmd /c "npm pack --pack-destination . 2>nul" | Where-Object { $_ -match '\.tgz$' } | Select-Object -Last 1)
    Pop-Location
    if (-not $Tgz) {
        # 本机没有 npm（如未安装 Node.js）时，回退到仓库根目录已存在的 tgz
        $Tgz = (Get-ChildItem $repo -Filter "dsh-web-bridge-*.tgz" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1).Name
        if ($Tgz) { Write-Host "npm 不可用，改用现成的安装包: $Tgz" }
    }
    if (-not $Tgz) { throw "无法获得安装包：npm pack 失败，且仓库根目录没有 dsh-web-bridge-*.tgz。请先在有 Node.js 的机器上执行 npm pack，把 tgz 一起拷贝过来后用 -Tgz 指定。" }
}
$TgzPath = if ([System.IO.Path]::IsPathRooted($Tgz)) { $Tgz } else { Join-Path $repo $Tgz }
if (-not (Test-Path $TgzPath)) { throw "安装包不存在：$TgzPath" }
Write-Host "[2/5] 安装包: $TgzPath"

# 3. 备份并修改 profile 的 package.json
$pkg = Join-Path $ProfileDir "package.json"
Copy-Item $pkg "$pkg.bak-webbridge" -Force
Copy-Item (Join-Path $ProfileDir "cordis.patch.yml") (Join-Path $ProfileDir "cordis.patch.yml.bak-webbridge") -Force
$edit = @"
const fs = require('fs');
const pkgPath = process.argv[2];
const tgz = process.argv[3].replace(/\\\\/g, '/');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies['dsh-web-bridge'] = 'file:' + tgz;
const bundles = pkg.dsh.profile.bundles;
if (!bundles.includes('dsh-web-bridge')) bundles.push('dsh-web-bridge');
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log('profile package.json updated');
"@
$editPath = Join-Path $env:TEMP "edit-dsh-profile.cjs"
Set-Content -Path $editPath -Value $edit -Encoding ASCII
& $nodeCmd $editPath $pkg $TgzPath
if ($LASTEXITCODE -ne 0) { throw "修改 profile 失败" }
Write-Host "[3/5] 已注册 dsh-web-bridge 到 bundles（原文件备份为 *.bak-webbridge）"

# 4. 安装依赖
Write-Host "[4/5] pnpm 安装依赖（使用桌面版自带 pnpm）..."
& $pnpmCmd --dir $ProfileDir install
if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败" }

# 5. setup 配对
Write-Host "[5/5] 生成本机配对密钥与 Chrome 扩展目录..."
& $nodeCmd (Join-Path $repo "bin\dsh-web-bridge.mjs") setup --profile-dir $ProfileDir
if ($LASTEXITCODE -ne 0) { throw "setup 失败" }

Write-Host ""
Write-Host "完成。接下来请手动操作："
Write-Host "  1. Chrome 打开 chrome://extensions -> 开发者模式 -> 加载已解压的扩展程序"
Write-Host "     选择目录：$ProfileDir\web-bridge\chrome"
Write-Host "     （如该 Chrome 曾加载过其他机器/其他 profile 的桥接扩展，先移除旧的）"
Write-Host "  2. 在该 Chrome 登录 https://chat.deepseek.com/"
Write-Host "  3. 启动 DSH Desktop，模型菜单选择「DeepSeek 网页」（deepseek-web）"
Write-Host "  4. 若提示未连接：先确认本机没有残留的旧 dsh web 进程占用 3081 端口"
