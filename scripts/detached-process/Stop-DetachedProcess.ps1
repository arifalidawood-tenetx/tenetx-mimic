<#
.SYNOPSIS
    Tears down a detached background process (and its full child tree) that was
    launched via Start-DetachedProcess.ps1, using a JSON PID-file that is safe
    against Windows PID recycling.

.NOTES
    Exit codes:
      0  nothing to stop (missing file) / already-dead PID / successful kill
      2  PID-file present but malformed or missing a usable 'pid'
      3  live PID's identity does NOT match the record (recycled PID) - not killed
      4  identity matched but taskkill failed
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PidFilePath,

    [Parameter(Mandatory = $false)]
    [string]$RegistryPath
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'DetachedProcess.Common.ps1')

if (-not (Test-Path -LiteralPath $PidFilePath)) {
    Write-Host "[OK] No PID-file at '$PidFilePath' - nothing to stop." -ForegroundColor Green
    exit 0
}

try {
    $raw = Get-Content -LiteralPath $PidFilePath -Raw
    $record = $raw | ConvertFrom-Json
}
catch {
    Write-Host "[ERROR] PID-file '$PidFilePath' is not valid JSON: $($_.Exception.Message)" -ForegroundColor Red
    exit 2
}

$targetPid = [int]$record.pid
$recordedName = [string]$record.processName
$recordedStart = [string]$record.startTime

if (-not $targetPid) {
    Write-Host "[ERROR] PID-file '$PidFilePath' has no usable 'pid' field." -ForegroundColor Red
    exit 2
}

$pruneRegistry = {
    if ($RegistryPath) {
        Remove-DetachedRegistryEntry -RegistryPath $RegistryPath -ProcessId $targetPid -PidFilePath $PidFilePath
        if (Test-Path -LiteralPath $RegistryPath) {
            Write-Host "[OK] Removed registry entry for PID $targetPid from '$RegistryPath'." -ForegroundColor Green
        }
    }
}

$result = Invoke-StopDetachedByRecord -ProcessId $targetPid -RecordedName $recordedName -RecordedStart $recordedStart

switch ($result.Outcome) {
    'AlreadyDead' {
        Write-Host "[OK] PID $targetPid is already gone - removing stale PID-file '$PidFilePath'." -ForegroundColor Green
        Remove-Item -LiteralPath $PidFilePath -Force
        & $pruneRegistry
        exit 0
    }
    'Mismatch' {
        Write-Host "[WARN] PID $targetPid is ALIVE but its identity does NOT match the PID-file." -ForegroundColor Yellow
        Write-Host "       Recorded: name='$recordedName', startTime='$recordedStart'" -ForegroundColor Yellow
        Write-Host "       Live:     name='$($result.LiveName)', startTime='$($result.LiveStart)'" -ForegroundColor Yellow
        Write-Host "       This looks like a RECYCLED PID (an unrelated process now owns it)." -ForegroundColor Yellow
        Write-Host "       Refusing to kill it. PID-file left in place: '$PidFilePath'." -ForegroundColor Yellow
        exit 3
    }
    'KillFailed' {
        Write-Host "Stopping PID $targetPid ('$($result.LiveName)') and its full process tree via 'taskkill /F /T /PID $targetPid' ..." -ForegroundColor Cyan
        foreach ($line in $result.KillOutput) {
            Write-Host "  $line"
        }
        Write-Host "[ERROR] taskkill failed for PID $targetPid (exit $($result.KillExit)). PID-file left in place: '$PidFilePath'." -ForegroundColor Red
        exit 4
    }
    'Killed' {
        Write-Host "Stopping PID $targetPid ('$($result.LiveName)') and its full process tree via 'taskkill /F /T /PID $targetPid' ..." -ForegroundColor Cyan
        foreach ($line in $result.KillOutput) {
            Write-Host "  $line"
        }
        Remove-Item -LiteralPath $PidFilePath -Force
        & $pruneRegistry
        Write-Host "[OK] Stopped PID $targetPid and removed PID-file '$PidFilePath'." -ForegroundColor Green
        exit 0
    }
}
