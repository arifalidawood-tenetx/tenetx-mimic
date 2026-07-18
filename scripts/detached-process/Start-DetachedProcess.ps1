<#
.SYNOPSIS
    Launches a command fully detached from the caller's console and tracks it
    via a recycling-safe JSON PID file.
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [Parameter(Mandatory = $false)]
    [string[]]$ArgumentList,

    [Parameter(Mandatory = $false)]
    [string]$WorkingDirectory,

    [Parameter(Mandatory = $true)]
    [string]$StdOutPath,

    [Parameter(Mandatory = $true)]
    [string]$StdErrPath,

    [Parameter(Mandatory = $true)]
    [string]$PidFilePath,

    [Parameter(Mandatory = $false)]
    [string]$RegistryPath,

    [Parameter(Mandatory = $false)]
    [string]$Label,

    [switch]$Visible
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'DetachedProcess.Common.ps1')

foreach ($outPath in @($StdOutPath, $StdErrPath, $PidFilePath)) {
    $parent = Split-Path -Parent $outPath
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
        Write-Host "[OK] Created directory: $parent" -ForegroundColor Green
    }
}

$startArgs = @{
    FilePath               = $FilePath
    PassThru               = $true
    RedirectStandardOutput = $StdOutPath
    RedirectStandardError  = $StdErrPath
}
if ($ArgumentList) {
    $startArgs.ArgumentList = $ArgumentList
}
if ($WorkingDirectory) {
    $startArgs.WorkingDirectory = $WorkingDirectory
}
if (-not $Visible) {
    $startArgs.WindowStyle = "Hidden"
}

Write-Host "Launching detached process: $FilePath" -ForegroundColor Cyan
$proc = Start-Process @startArgs

$proc.Refresh()

$pidRecord = [ordered]@{
    pid         = $proc.Id
    processName = $proc.ProcessName
    startTime   = $proc.StartTime.ToString("o")
}
$pidRecord | ConvertTo-Json | Set-Content -LiteralPath $PidFilePath -Encoding UTF8

Write-Host "[OK] Detached process started (PID $($proc.Id), name '$($proc.ProcessName)')." -ForegroundColor Green
Write-Host "[OK] PID file written: $PidFilePath" -ForegroundColor Green

if ($RegistryPath) {
    $entryLabel = if ($PSBoundParameters.ContainsKey('Label') -and $Label) { $Label } else { $FilePath }
    $registryEntry = [ordered]@{
        pid         = $proc.Id
        processName = $proc.ProcessName
        startTime   = $proc.StartTime.ToString("o")
        pidFilePath = $PidFilePath
        label       = $entryLabel
    }
    Add-DetachedRegistryEntry -RegistryPath $RegistryPath -Entry $registryEntry
    Write-Host "[OK] Registry entry appended: $RegistryPath (label '$entryLabel')." -ForegroundColor Green
}

return $proc.Id
