<#
.SYNOPSIS
    Shared, dot-sourced helper for the detached-process tooling. It is the SINGLE
    source of truth for (a) the recycling-safe identity check, (b) the
    `taskkill /F /T` full-tree kill, and (c) the JSON process-registry read/write
    logic used by Start/Stop/Get/Stop-All-DetachedProcess.

.DESCRIPTION
    This file defines functions ONLY. It has no param() block, runs no work at
    load time, and never calls `exit` - so it is safe to dot-source from any of
    the sibling scripts without side effects:

        . (Join-Path $PSScriptRoot 'DetachedProcess.Common.ps1')

    Functions exposed:
      Test-DetachedProcessIdentity  - live Get-Process + name/startTime compare
      Get-DetachedProcessStatus     - classify a record as ALIVE or STALE
      Stop-DetachedProcessTree      - taskkill /F /T /PID wrapper
      Invoke-StopDetachedByRecord   - identity-check THEN kill (composite)
      Read-DetachedRegistry         - defensive JSON-array read (never throws)
      Write-DetachedRegistry        - always writes a JSON ARRAY (even 0/1 items)
      Add-DetachedRegistryEntry     - append one record, re-parsing first
      Remove-DetachedRegistryEntry  - prune by (pid AND pidFilePath)

.NOTES
    Recording contract (kept identical to Start-DetachedProcess.ps1's PID file):
      { "pid": <int>, "processName": "<string>", "startTime": "<ISO8601 'o'>" }
    The registry array records a SUPERSET per entry:
      { "pid", "processName", "startTime", "pidFilePath", "label" }
#>

# Clock-skew tolerance (seconds) when matching a recorded StartTime against the
# live process's StartTime. Absorbs sub-second rounding in the ISO8601 round-trip
# without being loose enough to admit a recycled PID (a real recycle differs by
# far more than a couple of seconds). ONE definition, consumed everywhere.
$script:DetachedStartTimeToleranceSeconds = 2

function Test-DetachedProcessIdentity {
    <#
    .SYNOPSIS
        Looks up the live process by PID and reports whether it still matches the
        recorded { processName, startTime } identity. Never throws.
    .OUTPUTS
        PSCustomObject: Exists (bool), NameMatches (bool), StartMatches (bool),
        Process (System.Diagnostics.Process or $null).
    #>
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$RecordedName,
        [Parameter(Mandatory = $true)][string]$RecordedStart
    )

    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $proc) {
        return [pscustomobject]@{
            Exists       = $false
            NameMatches  = $false
            StartMatches = $false
            Process      = $null
        }
    }

    # ProcessName: EXACT match (PowerShell -eq on strings is case-insensitive,
    # which is correct for Windows process names).
    $nameMatches = ($proc.ProcessName -eq $RecordedName)

    # StartTime: within +/- tolerance. Both sides normalised to UTC first so a
    # Local-vs-UTC Kind mismatch in the ISO8601 round-trip can't fake an offset.
    $startMatches = $false
    try {
        $recordedStartDt = [datetime]::Parse(
            $RecordedStart, $null,
            [System.Globalization.DateTimeStyles]::RoundtripKind
        )
        $deltaSeconds = [math]::Abs(
            ($proc.StartTime.ToUniversalTime() - $recordedStartDt.ToUniversalTime()).TotalSeconds
        )
        $startMatches = ($deltaSeconds -le $script:DetachedStartTimeToleranceSeconds)
    }
    catch {
        # Unparseable/absent recorded start time -> cannot prove identity -> mismatch.
        $startMatches = $false
    }

    return [pscustomobject]@{
        Exists       = $true
        NameMatches  = $nameMatches
        StartMatches = $startMatches
        Process      = $proc
    }
}

function Get-DetachedProcessStatus {
    <#
    .SYNOPSIS
        Classifies a recorded process as 'ALIVE' (live AND identity matches) or
        'STALE' (gone, OR alive but recycled to an unrelated process).
    .OUTPUTS
        PSCustomObject: Status ('ALIVE'|'STALE'), Process (or $null), LiveName,
        LiveStart, Reason.
    #>
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$RecordedName,
        [Parameter(Mandatory = $true)][string]$RecordedStart
    )

    $id = Test-DetachedProcessIdentity -ProcessId $ProcessId -RecordedName $RecordedName -RecordedStart $RecordedStart

    if (-not $id.Exists) {
        return [pscustomobject]@{
            Status    = 'STALE'
            Process   = $null
            LiveName  = ''
            LiveStart = ''
            Reason    = 'PID not found (process already exited)'
        }
    }

    if ($id.NameMatches -and $id.StartMatches) {
        return [pscustomobject]@{
            Status    = 'ALIVE'
            Process   = $id.Process
            LiveName  = $id.Process.ProcessName
            LiveStart = $id.Process.StartTime.ToString('o')
            Reason    = 'live process identity matches record'
        }
    }

    return [pscustomobject]@{
        Status    = 'STALE'
        Process   = $id.Process
        LiveName  = $id.Process.ProcessName
        LiveStart = $id.Process.StartTime.ToString('o')
        Reason    = 'PID alive but recycled to an unrelated process (identity mismatch)'
    }
}

function Stop-DetachedProcessTree {
    <#
    .SYNOPSIS
        Force-kills a process AND its full child tree via `taskkill /F /T /PID`,
        so a wrapper (e.g. uv.exe) and its real child (python/uvicorn) both die.
    .OUTPUTS
        PSCustomObject: ExitCode (int from taskkill), Output (string[] captured).
    #>
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId
    )

    $killOutput = & taskkill.exe /F /T /PID $ProcessId 2>&1
    $killExit = $LASTEXITCODE
    return [pscustomobject]@{
        ExitCode = $killExit
        Output   = @($killOutput)
    }
}

function Invoke-StopDetachedByRecord {
    <#
    .SYNOPSIS
        Composite stop: identity-check a recorded {pid,processName,startTime}
        triple, then kill the tree ONLY on an identity match. Pure logic - it
        writes no host output and never exits; the caller formats + decides the
        process exit code. This is the ONE routine shared by Stop-DetachedProcess,
        Stop-AllDetachedProcesses (and the identity half by Get-DetachedProcesses).
    .OUTPUTS
        PSCustomObject:
          Outcome  : 'AlreadyDead' | 'Killed' | 'Mismatch' | 'KillFailed'
          Code     : 0 (already-dead or killed) | 3 (recycled mismatch) | 4 (taskkill failed)
          ProcessId, RecordedName, RecordedStart
          LiveName, LiveStart : live identity when the PID was alive (else '')
          KillOutput : string[] taskkill lines (when a kill was attempted)
          KillExit   : int taskkill exit (when a kill was attempted)
    #>
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$RecordedName,
        [Parameter(Mandatory = $true)][string]$RecordedStart
    )

    $id = Test-DetachedProcessIdentity -ProcessId $ProcessId -RecordedName $RecordedName -RecordedStart $RecordedStart

    if (-not $id.Exists) {
        return [pscustomobject]@{
            Outcome       = 'AlreadyDead'
            Code          = 0
            ProcessId     = $ProcessId
            RecordedName  = $RecordedName
            RecordedStart = $RecordedStart
            LiveName      = ''
            LiveStart     = ''
            KillOutput    = @()
            KillExit      = $null
        }
    }

    if (-not ($id.NameMatches -and $id.StartMatches)) {
        return [pscustomobject]@{
            Outcome       = 'Mismatch'
            Code          = 3
            ProcessId     = $ProcessId
            RecordedName  = $RecordedName
            RecordedStart = $RecordedStart
            LiveName      = $id.Process.ProcessName
            LiveStart     = $id.Process.StartTime.ToString('o')
            KillOutput    = @()
            KillExit      = $null
        }
    }

    $liveName = $id.Process.ProcessName
    $liveStart = $id.Process.StartTime.ToString('o')
    $kill = Stop-DetachedProcessTree -ProcessId $ProcessId

    if ($kill.ExitCode -ne 0) {
        return [pscustomobject]@{
            Outcome       = 'KillFailed'
            Code          = 4
            ProcessId     = $ProcessId
            RecordedName  = $RecordedName
            RecordedStart = $RecordedStart
            LiveName      = $liveName
            LiveStart     = $liveStart
            KillOutput    = $kill.Output
            KillExit      = $kill.ExitCode
        }
    }

    return [pscustomobject]@{
        Outcome       = 'Killed'
        Code          = 0
        ProcessId     = $ProcessId
        RecordedName  = $RecordedName
        RecordedStart = $RecordedStart
        LiveName      = $liveName
        LiveStart     = $liveStart
        KillOutput    = $kill.Output
        KillExit      = $kill.ExitCode
    }
}

function Read-DetachedRegistry {
    <#
    .SYNOPSIS
        Reads the JSON process-registry as an ARRAY. Defensive against every bad
        shape: missing file, empty file, malformed JSON, or a single (unwrapped)
        object. NEVER throws - a bad/absent registry simply yields @().
    .OUTPUTS
        object[] - the parsed entries (possibly empty).
    #>
    param(
        [Parameter(Mandatory = $false)][string]$RegistryPath
    )

    if ([string]::IsNullOrWhiteSpace($RegistryPath)) { return @() }
    if (-not (Test-Path -LiteralPath $RegistryPath)) { return @() }

    try {
        $raw = Get-Content -LiteralPath $RegistryPath -Raw -ErrorAction Stop
    }
    catch {
        return @()
    }
    if ([string]::IsNullOrWhiteSpace($raw)) { return @() }

    try {
        $parsed = $raw | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        # Malformed JSON -> treat as an empty registry (start fresh, never block).
        return @()
    }

    if ($null -eq $parsed) { return @() }
    # Normalise: a single JSON object comes back as one object, not an array.
    return @($parsed)
}

function Write-DetachedRegistry {
    <#
    .SYNOPSIS
        Writes the registry back as a JSON ARRAY, always - including 0 entries
        ([]) and 1 entry ([ {...} ]), sidestepping ConvertTo-Json's single-item
        unwrap. Creates the parent directory if missing. UTF-8, no BOM (pwsh7).
    #>
    param(
        [Parameter(Mandatory = $true)][string]$RegistryPath,
        [Parameter(Mandatory = $false)]$Entries
    )

    $parent = Split-Path -Parent $RegistryPath
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }

    $arr = @($Entries)
    if ($arr.Count -eq 0) {
        Set-Content -LiteralPath $RegistryPath -Value '[]' -Encoding UTF8
        return
    }

    # PIPE the array (do NOT use -InputObject) so the elements stream in one by
    # one: -InputObject $arr would treat the whole array as a single value and,
    # combined with -AsArray, emit a DOUBLE-nested [[...]]. Piping + -AsArray
    # (pwsh 6+) yields a flat [ {...}, ... ] even for a single element.
    $json = $arr | ConvertTo-Json -Depth 5 -AsArray
    Set-Content -LiteralPath $RegistryPath -Value $json -Encoding UTF8
}

function Add-DetachedRegistryEntry {
    <#
    .SYNOPSIS
        Appends one record to the registry, ALWAYS re-parsing the current file
        first (defensive against concurrent edits / malformed shape) so we write
        back the full, correct array. Fast: no waits, no locking.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$RegistryPath,
        [Parameter(Mandatory = $true)]$Entry
    )

    $entries = @(Read-DetachedRegistry -RegistryPath $RegistryPath)
    $entries = $entries + $Entry
    Write-DetachedRegistry -RegistryPath $RegistryPath -Entries $entries
}

function Remove-DetachedRegistryEntry {
    <#
    .SYNOPSIS
        Prunes entries matching BOTH pid AND pidFilePath, then writes the pruned
        array back. If the registry file is absent, silently does nothing (per
        spec: a supplied-but-missing registry is NOT an error).
    #>
    param(
        [Parameter(Mandatory = $true)][string]$RegistryPath,
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$PidFilePath
    )

    if (-not (Test-Path -LiteralPath $RegistryPath)) { return }

    $entries = @(Read-DetachedRegistry -RegistryPath $RegistryPath)
    $kept = @($entries | Where-Object {
            -not (([int]$_.pid -eq $ProcessId) -and ([string]$_.pidFilePath -eq $PidFilePath))
        })
    Write-DetachedRegistry -RegistryPath $RegistryPath -Entries $kept
}
