<#
.SYNOPSIS
    Lists every detached process tracked in a JSON registry, classifies each as
    ALIVE or STALE using the SAME recycling-safe identity check as
    Stop-DetachedProcess.ps1, and auto-prunes the stale ones from the registry.

.NOTES
    Exit codes:
      0  always (listing succeeded, including the empty / no-registry case)
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RegistryPath
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'DetachedProcess.Common.ps1')

if (-not (Test-Path -LiteralPath $RegistryPath)) {
    Write-Host "[OK] No registry at '$RegistryPath' - nothing tracked." -ForegroundColor Green
    exit 0
}

$entries = @(Read-DetachedRegistry -RegistryPath $RegistryPath)

if ($entries.Count -eq 0) {
    Write-Host "[OK] Registry '$RegistryPath' is empty - nothing tracked." -ForegroundColor Green
    exit 0
}

$rows = @()
$aliveEntries = @()
foreach ($e in $entries) {
    $entryPid = [int]$e.pid
    $status = Get-DetachedProcessStatus `
        -ProcessId $entryPid `
        -RecordedName ([string]$e.processName) `
        -RecordedStart ([string]$e.startTime)

    $rows += [pscustomobject]@{
        Pid         = $entryPid
        ProcessName = [string]$e.processName
        Label       = [string]$e.label
        Status      = $status.Status
    }

    if ($status.Status -eq 'ALIVE') {
        $aliveEntries += $e
    }
}

Write-Host "Detached processes tracked in '$RegistryPath':" -ForegroundColor Cyan
$rows | Format-Table -AutoSize Pid, ProcessName, Label, Status | Out-Host

$aliveCount = @($rows | Where-Object { $_.Status -eq 'ALIVE' }).Count
$staleCount = @($rows | Where-Object { $_.Status -eq 'STALE' }).Count
Write-Host "Total tracked: $($rows.Count)  |  ALIVE: $aliveCount  |  STALE: $staleCount" -ForegroundColor Cyan

if ($staleCount -gt 0) {
    Write-DetachedRegistry -RegistryPath $RegistryPath -Entries $aliveEntries
    $noun = if ($staleCount -eq 1) { "entry" } else { "entries" }
    Write-Host "[OK] Auto-pruned $staleCount stale $noun from '$RegistryPath' (kept $aliveCount alive)." -ForegroundColor Green
}

exit 0
