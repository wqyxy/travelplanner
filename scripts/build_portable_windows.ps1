[CmdletBinding()]
param(
  [string]$NodeDirectory = (Split-Path -Parent (Get-Command node -ErrorAction Stop).Source),
  [string]$OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'release')
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$nodeRoot = [IO.Path]::GetFullPath($NodeDirectory)
$output = [IO.Path]::GetFullPath($OutputDirectory)
$portable = Join-Path $output 'ai-travel-planner-windows-x64'
$node = Join-Path $nodeRoot 'node.exe'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'NodeDirectory 必须包含官方 Windows Node.js 24 x64 的 node.exe。' }
if ((& $node -p process.platform) -ne 'win32' -or (& $node -p process.arch) -ne 'x64' -or -not ((& $node -p process.versions.node).StartsWith('24.'))) { throw 'NodeDirectory 必须包含官方 Windows Node.js 24 x64 运行时。' }

Push-Location $root
try { & npm.cmd run typecheck; if ($LASTEXITCODE -ne 0) { throw '类型检查失败。' }; & npm.cmd test; if ($LASTEXITCODE -ne 0) { throw '单元测试失败。' }; & npm.cmd run build; if ($LASTEXITCODE -ne 0) { throw '生产构建失败。' } }
finally { Pop-Location }
if (Test-Path -LiteralPath $portable) { Remove-Item -LiteralPath $portable -Recurse -Force }
New-Item -ItemType Directory -Path $portable -Force | Out-Null
foreach ($entry in @('dist', 'node_modules', 'prompts', 'scripts', 'package.json', 'package-lock.json', 'VERSION', 'run.cmd', 'run.ps1', 'run.command', '.gitignore')) { Copy-Item -LiteralPath (Join-Path $root $entry) -Destination (Join-Path $portable $entry) -Recurse -Force }
Copy-Item -LiteralPath $nodeRoot -Destination (Join-Path $portable 'runtime') -Recurse -Force
Write-Host "便携版已创建：$portable"
