# tenqa29-live-repro.ps1
#
# TENQA-29 - live, non-elevated, deterministic proxy for the "Access Denied on
# reinstall" bug. Proves the fix mechanism WITHOUT any UAC / elevated terminal,
# using only a file owner's OWN inherent right to deny itself permissions.
#
# WHAT WE PROVE (the todo-1/2 diff mechanism):
#   OLD installer: Expand-Archive -Force  -> deletes the target file, then
#                  extracts. The DELETE step fails Access Denied when the file
#                  cannot be deleted in the current context.
#   NEW installer: staged-extract + Copy-Item -Force per file -> overwrites the
#                  file's CONTENT in place (truncate+write), which needs WRITE,
#                  not DELETE, so it succeeds where the delete would fail.
#
# METHOD NOTE (why the ACL is built the way it is - findings from this machine,
# DESKTOP-MKEF4UL, Windows PowerShell 5.1, all captured live in Part 1 below):
#   1. The naive `icacls <file> /deny "<user>:(D)"` does NOT deny Delete only -
#      it denies "Delete, Synchronize" (mask 0x110000). SYNCHRONIZE is requested
#      by EVERY synchronous file open (read/write/copy/delete), so an explicit
#      deny of it poisons ALL I/O - including the very Copy-Item the fix relies
#      on. So `(D)` cannot fairly test the fix (it blocks both old AND new).
#   2. A precise file-level Delete-only deny (0x10000) is DEFEATED by the parent
#      directory's FILE_DELETE_CHILD right (which the owner has), so Remove-Item
#      still succeeds - it fails to reproduce the symptom at all.
#   Therefore the FAITHFUL proxy (Part 2) denies Delete on the FILE *and*
#   DeleteSubdirectoriesAndFiles on the PARENT dir (killing the delete-child
#   backdoor), while leaving Synchronize + Write intact - so DELETE is genuinely
#   blocked but in-place CONTENT overwrite is still allowed. Part 1 documents the
#   literal spec'd `(D)` attempt for full honesty; Part 2 is authoritative.
#
# Throwaway QA repro - NOT wired into any package.json script. Run via:
#   Start-Transcript -Path <evidence.txt>; & .\tenqa29-live-repro.ps1; Stop-Transcript
#
# Honest-by-design: every check prints the raw error/type it saw; a check only
# reports PASS when the underlying OS behavior actually matched the claim.

$ErrorActionPreference = 'Continue'

# --- authoritative result flags (from Part 2) -----------------------------
$oldPass     = $false
$newPass     = $false
$oldDetails  = ''
$newDetails  = ''
$sandboxGone = $true
$naiveGone   = $true

# --- helpers: precise deny-ACE add/strip via the .NET ACL API -------------
$user = $env:USERNAME
function Add-DenyRule([string]$path, $rights) {
    $acl = Get-Acl $path
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        $user, $rights, [System.Security.AccessControl.AccessControlType]::Deny)))
    Set-Acl -Path $path -AclObject $acl
}
function Remove-DenyRules([string]$path) {
    try {
        $acl = Get-Acl $path
        $acl.Access | Where-Object { $_.AccessControlType -eq 'Deny' } |
            ForEach-Object { [void]$acl.RemoveAccessRule($_) }
        Set-Acl -Path $path -AclObject $acl
    } catch {}
}
function Get-DenyRights([string]$path) {
    (((Get-Acl $path).Access | Where-Object { $_.AccessControlType -eq 'Deny' } |
        ForEach-Object { $_.FileSystemRights }) -join ', ')
}

# --- sandbox paths (declared BEFORE the try so the finally can always see them) ---
$naiveSandbox   = Join-Path $env:TEMP "tenqa29_naive_$([guid]::NewGuid().ToString('N'))"
$sandbox        = Join-Path $env:TEMP "tenqa29_repro_$([guid]::NewGuid().ToString('N'))"
$destSandboxExe = Join-Path $sandbox 'tenetx.exe'
$stagingFile    = Join-Path $sandbox 'staged.exe'

Write-Host "=== TENQA-29 live non-elevated ACL repro ==="
Write-Host ("Timestamp : {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'))
Write-Host ("Machine   : {0}" -f $env:COMPUTERNAME)
Write-Host ("User      : {0} (non-elevated; no UAC prompt used)" -f $user)
Write-Host ("PSVersion : {0}" -f $PSVersionTable.PSVersion)
Write-Host ""

try {
    # =====================================================================
    # PART 1 - literal spec'd `icacls /deny "(D)"` (DIAGNOSTIC; over-broad)
    # =====================================================================
    Write-Host "===================== PART 1 (diagnostic) ====================="
    Write-Host "Literal spec command: icacls <file> /deny `"<user>:(D)`" - shown to be"
    Write-Host "over-broad on this build (denies Delete+Synchronize, blocking ALL I/O)."
    Write-Host ""
    New-Item -ItemType Directory -Force -Path $naiveSandbox | Out-Null
    $naiveExe = Join-Path $naiveSandbox 'tenetx.exe'
    Set-Content -Path $naiveExe -Value "v1"

    Write-Host "--- P1.2: icacls /deny `"$($user):(D)`" ---"
    icacls $naiveExe /deny "$($user):(D)"
    Write-Host ("icacls /deny exit code: {0}" -f $LASTEXITCODE)
    Write-Host ("Deny rights actually applied (Get-Acl): '{0}'" -f (Get-DenyRights $naiveExe))
    Write-Host "  -> note the SYNCHRONIZE bit: this is why it over-blocks."
    Write-Host ""

    Write-Host "--- P1.3: Remove-Item under (D) ---"
    try {
        Remove-Item $naiveExe -Force -ErrorAction Stop
        Write-Host "PART 1 Remove-Item: SUCCEEDED (unexpected)"
    } catch {
        Write-Host ("PART 1 Remove-Item: BLOCKED [{0}] {1}" -f $_.Exception.GetType().Name, $_.Exception.Message)
    }

    if (Test-Path $naiveExe) {
        Write-Host "--- P1.4: Copy-Item -Force under (D) (the fix's command) ---"
        $naiveStage = Join-Path $naiveSandbox 'staged.exe'; Set-Content -Path $naiveStage -Value "v2"
        try {
            Copy-Item -Path $naiveStage -Destination $naiveExe -Force -ErrorAction Stop
            Write-Host ("PART 1 Copy-Item: SUCCEEDED (content now '{0}')" -f (Get-Content $naiveExe -Raw).Trim())
        } catch {
            Write-Host ("PART 1 Copy-Item: ALSO BLOCKED [{0}] {1}" -f $_.Exception.GetType().Name, $_.Exception.Message)
        }
    }
    Write-Host ""
    Write-Host "PART 1 CONCLUSION: `icacls (D)` denies Delete+Synchronize, so it blocks BOTH"
    Write-Host "the old delete AND the new Copy-Item - it cannot fairly test the fix."
    Write-Host "Escalating to the faithful proxy in Part 2."
    Write-Host ""

    # inline naive cleanup (also swept defensively in finally)
    Remove-DenyRules $naiveExe
    icacls $naiveExe /remove:d "$user" 2>$null | Out-Null
    Remove-Item -Recurse -Force $naiveSandbox -ErrorAction SilentlyContinue

    # =====================================================================
    # PART 2 - FAITHFUL proxy (AUTHORITATIVE)
    #   deny Delete on the file + DeleteSubdirectoriesAndFiles on the parent,
    #   leaving Synchronize/Write intact -> delete blocked, overwrite allowed.
    # =====================================================================
    Write-Host "===================== PART 2 (authoritative) ====================="

    # --- Step 1: sandbox + dummy destination exe ("v1") ------------------
    New-Item -ItemType Directory -Force -Path $sandbox | Out-Null
    Set-Content -Path $destSandboxExe -Value "v1"
    Write-Host ("Sandbox   : {0}" -f $sandbox)
    Write-Host ("Dest exe  : {0}  (content '{1}')" -f $destSandboxExe, (Get-Content $destSandboxExe -Raw).Trim())
    Write-Host ""

    # --- Step 2: deny Delete on file + DeleteChild on parent (self-deny) --
    Write-Host "--- Step 2: self-deny Delete on the file + DeleteChild on the parent dir ---"
    Add-DenyRule $destSandboxExe ([System.Security.AccessControl.FileSystemRights]::Delete)
    Add-DenyRule $sandbox        ([System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles)
    Write-Host ("  file deny rights: '{0}'" -f (Get-DenyRights $destSandboxExe))
    Write-Host ("  dir  deny rights: '{0}'" -f (Get-DenyRights $sandbox))
    Write-Host "  (Synchronize + Write intentionally NOT denied - only deletion is blocked)"
    Write-Host ""

    # --- Step 3: OLD behavior - Remove-Item (mirrors Expand-Archive delete) ---
    Write-Host "--- Step 3: OLD BEHAVIOR - Remove-Item -Force (expected: DENIED) ---"
    try {
        Remove-Item $destSandboxExe -Force -ErrorAction Stop
        $oldPass    = $false
        $oldDetails = "Remove-Item unexpectedly SUCCEEDED - deletion was NOT blocked (FALSE NEGATIVE for the repro)."
    } catch {
        $ex = $_.Exception; $msg = $ex.Message; $fqid = $_.FullyQualifiedErrorId
        $isAccessDenied = ($ex -is [System.UnauthorizedAccessException]) -or ($msg -match '(?i)denied') -or ($fqid -match '(?i)unauthorized')
        if ($isAccessDenied) {
            $oldPass = $true
            Write-Host "Caught EXPECTED access-denied error:"
            Write-Host ("  Type : {0}" -f $ex.GetType().FullName)
            Write-Host ("  FQID : {0}" -f $fqid)
            Write-Host ("  Msg  : {0}" -f $msg)
        } else {
            $oldPass    = $false
            $oldDetails = "Remove-Item threw a NON-access-denied error: [{0}] {1}" -f $ex.GetType().FullName, $msg
        }
    }
    if ($oldPass) { Write-Host "OLD BEHAVIOR CHECK (Remove-Item denied): PASS" }
    else          { Write-Host ("OLD BEHAVIOR CHECK (Remove-Item denied): FAIL - {0}" -f $oldDetails) }
    Write-Host ""

    # --- Step 4: NEW behavior - Copy-Item -Force overwrites content in place ---
    Write-Host "--- Step 4: NEW BEHAVIOR - Copy-Item -Force over the delete-denied file (expected: SUCCEEDS) ---"
    Set-Content -Path $stagingFile -Value "v2"
    Write-Host ("Staging file: {0} (content '{1}')" -f $stagingFile, (Get-Content $stagingFile -Raw).Trim())
    try {
        Copy-Item -Path $stagingFile -Destination $destSandboxExe -Force -ErrorAction Stop
        $readBack = (Get-Content -Path $destSandboxExe -Raw).Trim()
        Write-Host ("Read-back content of dest exe after Copy-Item: '{0}'" -f $readBack)
        if ($readBack -eq 'v2') {
            $newPass = $true
        } else {
            $newPass    = $false
            $newDetails = "Copy-Item reported success but dest content is '$readBack', expected 'v2'"
        }
    } catch {
        $ex = $_.Exception
        $newPass    = $false
        $newDetails = "Copy-Item threw: [{0}] {1}" -f $ex.GetType().FullName, $ex.Message
    }
    if ($newPass) { Write-Host "NEW BEHAVIOR CHECK (Copy-Item overwrites in place): PASS" }
    else          { Write-Host ("NEW BEHAVIOR CHECK (Copy-Item overwrites in place): FAIL - {0}" -f $newDetails) }
    Write-Host ""
}
finally {
    # --- Step 5: cleanup (ALWAYS runs; strips deny ACEs first) ------------
    Write-Host "--- Step 5: cleanup (runs in finally, even on failure) ---"

    # Part 1 naive sandbox (defensive - normally already removed inline)
    if (Test-Path $naiveSandbox) {
        Get-ChildItem $naiveSandbox -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object {
            Remove-DenyRules $_.FullName
            icacls $_.FullName /remove:d "$user" 2>$null | Out-Null
        }
        Remove-Item -Recurse -Force $naiveSandbox -ErrorAction SilentlyContinue
    }
    $naiveGone = -not (Test-Path $naiveSandbox)

    # Part 2 faithful sandbox - MUST strip the Delete/DeleteChild denies first
    if (Test-Path $sandbox) {
        Remove-DenyRules $sandbox
        Get-ChildItem $sandbox -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object {
            Remove-DenyRules $_.FullName
        }
        Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue
    }
    $sandboxGone = -not (Test-Path $sandbox)

    Write-Host ("Test-Path `$sandbox -> {0}" -f (Test-Path $sandbox))
    Write-Host ("Test-Path `$naiveSandbox -> {0}" -f (Test-Path $naiveSandbox))
    Write-Host ""

    # --- Final result summary (authoritative = Part 2; exact acceptance phrasing) ---
    Write-Host "=== RESULT SUMMARY (authoritative = Part 2 faithful proxy) ==="
    Write-Host ("old behavior reproduces Access Denied: {0}" -f $(if ($oldPass) { 'PASS' } else { 'FAIL' }))
    Write-Host ("new behavior overwrites in place: {0}"      -f $(if ($newPass) { 'PASS' } else { 'FAIL' }))
    Write-Host ("cleanup - sandbox removed (Test-Path -eq False): {0}" -f $(if ($sandboxGone) { 'PASS' } else { 'FAIL' }))
    Write-Host ("cleanup - naive sandbox removed: {0}" -f $(if ($naiveGone) { 'PASS' } else { 'FAIL' }))
}
