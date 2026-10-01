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
# this machine instead.
#
# WHY IT DOES NOT USE THE DEFAULT INDEX
#
# pypi.org itself is often the thing that is blocked. The Tsinghua mirror is
# reachable from networks where pypi.org stalls, and it carries the same
# packages. If the mirror is unreachable the script falls back to the default
# index rather than refusing to try.
#
# It creates its own virtual environment under python\.venv, so nothing is
# installed into your system Python and nothing needs administrator rights.
# Deleting that folder undoes all of it.
#
# The MODEL is fetched here too, because "the library is installed but the
# weights never arrive" is a half-finished setup that looks like a bug. Hugging
# Face — where faster-whisper looks by default — is blocked on the same networks
# that block pypi.org, so ModelScope is tried as well.

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$venv = Join-Path $here ".venv"
$python = Join-Path $venv "Scripts\python.exe"
$models = Join-Path $here "models"

$Mirror = "https://pypi.tuna.tsinghua.edu.cn/simple"
$HfMirror = "https://hf-mirror.com"

Write-Host ""
Write-Host "  Xana - local transcriber setup" -ForegroundColor Cyan
Write-Host ""

function Find-Interpreter {
    foreach ($candidate in @("py", "python", "python3")) {
        $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
        if (-not $cmd) { continue }
        if ($candidate -eq "py") { return @("py", "-3") }
        return @($candidate)
    }
    return $null
}

# --- 1. An interpreter ---------------------------------------------------
$interpreter = Find-Interpreter
if (-not $interpreter) {
    Write-Host "  Python was not found on this machine." -ForegroundColor Red
    Write-Host ""
    Write-Host "  Install it from https://www.python.org/downloads/ (3.9 or newer),"
    Write-Host "  tick 'Add python.exe to PATH' during setup, then run this again."
    Write-Host ""
    exit 1
}

$exe = $interpreter[0]
$prefix = @()
if ($interpreter.Length -gt 1) { $prefix = $interpreter[1..($interpreter.Length - 1)] }
Write-Host "  Found $(& $exe @prefix --version 2>&1)"

# --- 2. The virtual environment -----------------------------------------
if (-not (Test-Path $python)) {
    Write-Host "  Creating python\.venv ..."
    & $exe @prefix -m venv $venv
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Could not create the virtual environment." -ForegroundColor Red
        exit 1
    }
}

# --- 3. The library ------------------------------------------------------
Write-Host "  Installing faster-whisper ..."
& $python -m pip install --upgrade pip --quiet --disable-pip-version-check --index-url $Mirror 2>&1 | Out-Null
& $python -m pip install --quiet --disable-pip-version-check --index-url $Mirror faster-whisper

if ($LASTEXITCODE -ne 0) {
    Write-Host "  The mirror did not work; trying the default index ..." -ForegroundColor Yellow
    & $python -m pip install --quiet --disable-pip-version-check faster-whisper
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "  Could not install faster-whisper from either index." -ForegroundColor Red
        Write-Host "  This step needs internet once; transcription afterwards does not."
        Write-Host "  If you use a proxy, set HTTPS_PROXY and run this again."
        exit 1
    }
}
Write-Host "  faster-whisper installed." -ForegroundColor Green

# --- 4. The model weights ------------------------------------------------
#
# faster-whisper asks Hugging Face for these. On a blocked network that request
# fails with an SSL error and leaves a library that is installed but useless, so
# the weights are fetched up front, from whichever source answers, into a folder
# this project owns.
$modelName = if ($env:XANA_STT_MODEL) { $env:XANA_STT_MODEL } else { "tiny" }
$target = Join-Path $models $modelName

if (Test-Path $target) {
    Write-Host "  Model '$modelName' already present." -ForegroundColor Green
} else {
    Write-Host "  Fetching the '$modelName' model weights ..."
    New-Item -ItemType Directory -Force -Path $models | Out-Null

    $fetch = @"
import os, sys
name = sys.argv[1]
target = sys.argv[2]
models_dir = sys.argv[3]
os.environ.setdefault('HF_ENDPOINT', '$HfMirror')
os.environ['MODELSCOPE_CACHE'] = models_dir

# 1. Try ModelScope first: it answers on networks where Hugging Face stalls.
try:
    from modelscope import snapshot_download
    path = snapshot_download('pengzhendong/faster-whisper-' + name, cache_dir=models_dir)
    print('OK modelscope ' + path)
    sys.exit(0)
except Exception as e:
    print('modelscope failed: ' + type(e).__name__ + ' ' + str(e)[:160])

# 2. Then Hugging Face, through its mirror endpoint.
try:
    from huggingface_hub import snapshot_download as hf_download
    path = hf_download('Systran/faster-whisper-' + name, cache_dir=models_dir)
    print('OK huggingface ' + path)
    sys.exit(0)
except Exception as e:
    print('huggingface failed: ' + type(e).__name__ + ' ' + str(e)[:160])

sys.exit(1)
"@

    $fetchPath = Join-Path $env:TEMP "xana-fetch-model.py"
    Set-Content -LiteralPath $fetchPath -Value $fetch -Encoding UTF8

    & $python -m pip install --quiet --disable-pip-version-check --index-url $Mirror modelscope 2>&1 | Out-Null

    $output = & $python $fetchPath $modelName $target $models 2>&1
    $output | ForEach-Object { Write-Host "      $_" }

    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "  The model could not be downloaded." -ForegroundColor Red
        Write-Host "  It will also be fetched automatically on the first transcription,"
        Write-Host "  so this is not fatal - but if that fails too, nothing will transcribe."
        Write-Host ""
        Write-Host "  Manual option: download a CTranslate2 Whisper model from"
        Write-Host "  https://hf-mirror.com/Systran/faster-whisper-base and set"
        Write-Host "  XANA_STT_MODEL to the folder containing model.bin."
    } else {
        Write-Host "  Model ready." -ForegroundColor Green
    }
}

# --- 5. Prove it runs ----------------------------------------------------
Write-Host ""
Write-Host "  Checking the service ..." -ForegroundColor Cyan
& $python (Join-Path $here "xana_stt.py") --selftest
if ($LASTEXITCODE -ne 0) {
    Write-Host "  The service failed its own self-test. Please report the output above." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "  Ready." -ForegroundColor Green
Write-Host ""
Write-Host "  1. Start it:   powershell -ExecutionPolicy Bypass -File python\serve.ps1"
Write-Host "  2. In Xana:    Settings > Voice > Transcription > 'This machine, with local Whisper'"
Write-Host "  3. Press:      Check the local transcriber"
Write-Host ""
if (Test-Path $target) {
    Write-Host "  The model is at $target"
    Write-Host "  serve.ps1 points at it automatically."
}
Write-Host ""
