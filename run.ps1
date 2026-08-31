$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$runtime = Join-Path $root 'runtime\node.exe'
if (Test-Path -LiteralPath $runtime) { & $runtime 'dist\server\index-cutover-v3.js' } else { & node 'dist\server\index-cutover-v3.js' }
