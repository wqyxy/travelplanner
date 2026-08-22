[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [int] $Port,
  [Parameter(Mandatory = $true)]
  [string] $Root
)

$ErrorActionPreference = 'Stop'
$rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\')
$processes = @(Get-CimInstance Win32_Process)

function Find-Process([int] $ProcessId) {
  return $processes | Where-Object { $_.ProcessId -eq $ProcessId } | Select-Object -First 1
}

function Is-TravelPlannerProcess($Process) {
  if (-not $Process) { return $false }
  $commandLine = [string] $Process.CommandLine
  return $commandLine -like "*$rootPath*" -or
    $commandLine -match 'apps[\\/]server[\\/]index\.ts' -or
    $commandLine -match 'dist[\\/]server[\\/]index\.js'
}

$listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
foreach ($listener in $listeners) {
  $listenerProcess = Find-Process ([int] $listener.OwningProcess)
  if (-not (Is-TravelPlannerProcess $listenerProcess)) {
    $name = if ($listenerProcess) { [string] $listenerProcess.Name } else { 'unknown process' }
    Write-Error "Port $Port is occupied by $name (PID $($listener.OwningProcess)), not by this travelplanner project. It will not be terminated."
  }

  $target = $listenerProcess
  $current = $listenerProcess
  $visited = @{}
  while ($current -and $current.ParentProcessId -and -not $visited.ContainsKey([int] $current.ProcessId)) {
    $visited[[int] $current.ProcessId] = $true
    $parent = Find-Process ([int] $current.ParentProcessId)
    if (-not $parent) { break }
    if (Is-TravelPlannerProcess $parent) { $target = $parent }
    $current = $parent
  }

  Write-Host "Stopping existing travelplanner process tree (PID $($target.ProcessId))..."
  & taskkill.exe /PID ([int] $target.ProcessId) /T /F | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Could not stop travelplanner process tree (PID $($target.ProcessId))."
  }
}

for ($attempt = 0; $attempt -lt 25; $attempt++) {
  $remaining = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  if ($remaining.Count -eq 0) { exit 0 }
  Start-Sleep -Milliseconds 200
}

Write-Error "Port $Port is still occupied after stopping the existing travelplanner process."
