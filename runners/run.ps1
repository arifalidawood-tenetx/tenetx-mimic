<#
.SYNOPSIS
    Interactive dev runner bootstrap: ensures a local `uv`-managed Python venv
    at runners/.venv with `rich`+`psutil` installed, AND a separate dedicated
    venv at tenetx-mimic-backend/.venv with the FastAPI backend's own deps
    (fastapi/uvicorn/python3-saml/xmlsec/firebase-admin/...) installed - the
    two are kept isolated so this tool's own deps never mix with the app's.
    Then execs runners/run.py (the actual interactive CLI: frees ports
    8998/6116, launches both dev servers, live dashboard + persisted logging).
    Note: on a machine with a Restricted PowerShell execution policy, invoke
    this via `powershell -ExecutionPolicy Bypass -File runners/run.ps1`.
#>

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$PythonArgs
)

$ErrorActionPreference = "Stop"

$venvPath = Join-Path $PSScriptRoot ".venv"
$reqPath = Join-Path $PSScriptRoot "requirements.txt"
$pythonExe = Join-Path $venvPath "Scripts\python.exe"
$runPy = Join-Path $PSScriptRoot "run.py"

$repoRoot = Split-Path $PSScriptRoot -Parent
$backendDir = Join-Path $repoRoot "tenetx-mimic-backend"
$backendVenvPath = Join-Path $backendDir ".venv"
$backendReqPath = Join-Path $backendDir "requirements.txt"
$backendPythonExe = Join-Path $backendVenvPath "Scripts\python.exe"

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] 'uv' was not found on PATH." -ForegroundColor Red
    Write-Host "        Install it: https://docs.astral.sh/uv/getting-started/installation/" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path -LiteralPath $venvPath)) {
    Write-Host "Creating venv at '$venvPath' ..." -ForegroundColor Cyan
    & uv venv $venvPath --python 3.12
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] 'uv venv' failed (exit $LASTEXITCODE)." -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

Write-Host "Syncing dependencies from '$reqPath' ..." -ForegroundColor Cyan
& uv pip install --python $pythonExe -r $reqPath
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] 'uv pip install' failed (exit $LASTEXITCODE)." -ForegroundColor Red
    exit $LASTEXITCODE
}

if (-not (Test-Path -LiteralPath $pythonExe)) {
    Write-Host "[ERROR] venv python not found at '$pythonExe' after setup." -ForegroundColor Red
    exit 1
}

# Backend's own venv (isolated from runners/.venv above): fastapi/uvicorn/
# python3-saml/xmlsec/firebase-admin etc., per tenetx-mimic-backend/requirements.txt.
if (-not (Test-Path -LiteralPath $backendVenvPath)) {
    Write-Host "Creating backend venv at '$backendVenvPath' ..." -ForegroundColor Cyan
    & uv venv $backendVenvPath --python 3.12
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] 'uv venv' (backend) failed (exit $LASTEXITCODE)." -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

Write-Host "Syncing backend dependencies from '$backendReqPath' ..." -ForegroundColor Cyan
& uv pip install --python $backendPythonExe -r $backendReqPath
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] 'uv pip install' (backend) failed (exit $LASTEXITCODE)." -ForegroundColor Red
    exit $LASTEXITCODE
}

if (-not (Test-Path -LiteralPath $backendPythonExe)) {
    Write-Host "[ERROR] backend venv python not found at '$backendPythonExe' after setup." -ForegroundColor Red
    exit 1
}

& $pythonExe $runPy @PythonArgs
exit $LASTEXITCODE
