# Set up the local transcriber.
#
#   powershell -ExecutionPolicy Bypass -File python\setup.ps1
#
# WHY THIS EXISTS
#
# The browser's speech recognition is a network round trip. On a network where
# that service is blocked — a corporate proxy, a campus firewall — every attempt
# fails with the error name `network` however good the microphone is, and no
# amount of retrying helps. This installs the transcriber that does the work on
# this machine instead, so dictation and always-listening no longer depend on
# reaching anyone.
#
# It creates its own virtual environment under python\.venv, so nothing is
# installed into your system Python and nothing needs administrator rights.
# Removing the folder undoes all of it.
#
# The model downloads on first use, not here. Nothing below needs a key.

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$venv = Join-Path $here ".venv"
$python = Join-Path $venv "Scripts\python.exe"

Write-Host ""
Write-Host "  Xana — local transcriber setup" -ForegroundColor Cyan
Write-Host ""

function Find-Interpreter {
    foreach ($candidate in @("py", "python", "python3")) {
        $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
        if (-not $cmd) { continue }
        # `py -3` needs the version flag; the others are the interpreter itself.
        if ($candidate -eq "py") { return @("py", "-3") }
        return @($candidate)
    }
    return $null
}

$interpreter = Find-Interpreter
if (-not $interpreter) {
    Write-Host "  Python was not found on this machine." -ForegroundColor Red
    Write-Host ""
    Write-Host "  Install it from https://www.python.org/downloads/ (any 3.9 or newer),"
    Write-Host "  tick 'Add python.exe to PATH' during setup, then run this again."
    Write-Host ""
    exit 1
}

$exe = $interpreter[0]
$prefix = @()
if ($interpreter.Length -gt 1) { $prefix = $interpreter[1..($interpreter.Length - 1)] }

$version = & $exe @prefix --version 2>&1
Write-Host "  Found $version"

if (-not (Test-Path $venv)) {
    Write-Host "  Creating python\.venv ..."
    & $exe @prefix -m venv $venv
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Could not create the virtual environment." -ForegroundColor Red
        exit 1
    }
}

Write-Host "  Installing faster-whisper (this downloads ~100 MB the first time)..."
& $python -m pip install --upgrade pip --quiet --disable-pip-version-check
& $python -m pip install --quiet --disable-pip-version-check faster-whisper
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  The install failed. The usual cause is no internet access to PyPI." -ForegroundColor Red
    Write-Host "  This step needs a connection once; transcription afterwards does not."
    exit 1
}

Write-Host ""
Write-Host "  Checking the service can start..." -ForegroundColor Cyan
& $python (Join-Path $here "xana_stt.py") --selftest
if ($LASTEXITCODE -ne 0) {
    Write-Host "  The service failed its own self-test. Please report the output above." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "  Ready." -ForegroundColor Green
Write-Host ""
Write-Host "  Start it with:   powershell -ExecutionPolicy Bypass -File python\serve.ps1"
Write-Host "  Then in Xana:    Settings > Voice > Transcription > 'This machine, with local Whisper'"
Write-Host ""
Write-Host "  The first transcription downloads the model (about 150 MB for 'base')."
Write-Host "  To use a smaller or larger one:  `$env:XANA_STT_MODEL = 'tiny'  (or 'small')"
Write-Host ""
