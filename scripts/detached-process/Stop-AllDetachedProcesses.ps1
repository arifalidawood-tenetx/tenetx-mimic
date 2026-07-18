<#
.SYNOPSIS
    Tears down EVERY detached process tracked in a JSON registry, using the SAME
    recycling-safe identity-check + `taskkill /F /T` tree-kill logic as
    Stop-DetachedProcess.ps1 (shared verbatim via DetachedProcess.Common.ps1).

.NOTES
    Exit codes:
      0  no registry / all entries stopped or already dead (nothing left running)
      1  at least one entry's taskkill FAILED (those entries are kept for retry)
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RegistryPath
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'DetachedProcess.Common.ps1')

if (-not (Test-Path -LiteralPath $RegistryPath)) {
    Write-Host "[OK] No registry at '$RegistryPath' - nothing to stop." -ForegroundColor Green
    exit 0
}

$entries = @(Read-DetachedRegistry -RegistryPath $RegistryPath)

if ($entries.Count -eq 0) {
    Write-Host "[OK] Registry '$RegistryPath' is empty - nothing to stop." -ForegroundColor Green
    exit 0
}

Write-Host "Stopping $($entries.Count) detached process(es) tracked in '$RegistryPath' ..." -ForegroundColor Cyan

$passCount = 0
$failCount = 0
$keptEntries = @()

foreach ($e in $entries) {
    $entryPid = [int]$e.pid
    $entryLabel = [string]$e.label
    $entryPidFile = [string]$e.pidFilePath

    $result = Invoke-StopDetachedByRecord `
        -ProcessId $entryPid `
        -RecordedName ([string]$e.processName) `
        -RecordedStart ([string]$e.startTime)

    switch ($result.Outcome) {
        'Killed' {
            Write-Host "  [PASS] pid=$entryPid label='$entryLabel' -> stopped (tree-killed)." -ForegroundColor Green
            if ($entryPidFile -and (Test-Path -LiteralPath $entryPidFile)) {
                Remove-Item -LiteralPath $entryPidFile -Force
            }
            $passCount++
        }
        'AlreadyDead' {
            Write-Host "  [PASS] pid=$entryPid label='$entryLabel' -> already dead." -ForegroundColor Green
            if ($entryPidFile -and (Test-Path -LiteralPath $entryPidFile)) {
                Remove-Item -LiteralPath $entryPidFile -Force
            }
            $passCount++
        }
        'Mismatch' {
            Write-Host "  [PASS] pid=$entryPid label='$entryLabel' -> already dead (PID recycled to '$($result.LiveName)', left untouched)." -ForegroundColor Yellow
            $passCount++
        }
        'KillFailed' {
            Write-Host "  [FAIL] pid=$entryPid label='$entryLabel' -> taskkill exit $($result.KillExit) (entry kept for retry)." -ForegroundColor Red
            foreach ($line in $result.KillOutput) {
                Write-Host "         $line"
            }
            $keptEntries += $e
            $failCount++
        }
    }
}

Write-DetachedRegistry -RegistryPath $RegistryPath -Entries $keptEntries

Write-Host "Summary: $($entries.Count) tracked  |  stopped/dead: $passCount  |  failed: $failCount" -ForegroundColor Cyan

if ($failCount -gt 0) {
    Write-Host "[ERROR] $failCount process(es) could not be stopped; their registry entries were kept." -ForegroundColor Red
    exit 1
}

Write-Host "[OK] All tracked processes stopped (or already dead). Registry '$RegistryPath' is now empty." -ForegroundColor Green
exit 0
