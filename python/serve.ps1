# Starts Xana's local speech-to-text sidecar.
#
#   powershell -ExecutionPolicy Bypass -File python\serve.ps1
#
# It is a launcher and nothing else: the Python file does the work, and every
# argument is passed straight through, so the same flags work here.
#
#   python\serve.ps1 --port 4400
#   python\serve.ps1 --selftest
#   python\serve.ps1 --wake-selftest
#
# Settings are environment variables, read by xana_stt.py itself:
#
#   XANA_STT_HOST     bind address                        (default 127.0.0.1)
#   XANA_STT_PORT     port                                (default 4319)
#   XANA_STT_MODEL    Whisper model                       (auto-detected below)
#   XANA_STT_BACKEND  auto | faster-whisper | whisper     (default auto)
#
# Nothing here sets XANA_STT_HOST. Binding anywhere but loopback publishes an
# unauthenticated transcription service to the network, and that is a decision
# for the person typing the command, not for a convenience script.
#
# THE VIRTUAL ENVIRONMENT AND THE MODEL ARE CHOSEN HERE
#
# `setup.ps1` installs into python\.venv and downloads the weights into
# python\models. Neither is on PATH and neither has a name faster-whisper would
# guess, so this script finds them: the venv's interpreter is preferred over
# whatever python is on PATH, and the newest model folder is handed over as
# XANA_STT_MODEL. Without that, a successful setup still starts a service that
# reports "no engine installed", which reads as a broken install rather than a
# launcher that did not look.

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$program = Join-Path $here "xana_stt.py"

if (-not (Test-Path -LiteralPath $program)) {
    Write-Host "xana_stt.py is not next to serve.ps1 (looked in $here)."
    exit 1
}

# --- Prefer the environment setup.ps1 built ---------------------------------
$venvPython = Join-Path $here ".venv\Scripts\python.exe"
$usingVenv = Test-Path -LiteralPath $venvPython

# --- Find a model's folder, if setup.ps1 downloaded one ---------------------
function Find-LocalModel {
    $models = Join-Path $here "models"
    if (-not (Test-Path -LiteralPath $models)) { return $null }
    # ModelScope nests by owner--name/snapshots/revision; Hugging Face by
    # models--owner--name/snapshots/<hash>. A folder containing model.bin is the
    # only thing faster-whisper can actually load, so that is what is searched for.
    $found = Get-ChildItem -LiteralPath $models -Recurse -Filter "model.bin" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($found) { return $found.DirectoryName }
    return $null
}

if (-not $env:XANA_STT_MODEL) {
    $local = Find-LocalModel
    if ($local) {
        $env:XANA_STT_MODEL = $local
        Write-Host "  model: $local" -ForegroundColor DarkGray
    }
}

# `py -3` first, then the two names a python.org installer and a Microsoft
# Store install use. The first one that answers `--version` wins.
function Get-PythonLauncher {
    $candidates = @(
        @{ Exe = "py"; Args = @("-3") },
        @{ Exe = "python"; Args = @() },
        @{ Exe = "python3"; Args = @() }
    )
    foreach ($candidate in $candidates) {
        $found = Get-Command $candidate.Exe -ErrorAction SilentlyContinue
        if (-not $found) { continue }
        try {
            & $found.Source @($candidate.Args + @("--version")) *> $null
            if ($LASTEXITCODE -eq 0) {
                return @{ Exe = $found.Source; Args = $candidate.Args }
            }
        } catch {
            continue
        }
    }
    return $null
}

$python = Get-PythonLauncher
if (-not $python) {
    Write-Host "No Python 3 interpreter was found on PATH."
    Write-Host ""
    Write-Host "Install Python 3 from https://www.python.org/downloads/ and tick"
    Write-Host "'Add python.exe to PATH' during setup, then run this again."
    Write-Host ""
    Write-Host "Xana works without this service: the mic button falls back to the"
    Write-Host "browser's own speech recognition."
    exit 1
}

if ($usingVenv) {
    # The venv is where setup.ps1 put faster-whisper. Preferring it means a
    # machine with a system Python that has never heard of this project still
    # works, and one where both exist gets the one that was prepared.
    & $venvPython @($program) @args
} else {
    Write-Host "  note: python\.venv not found - run python\setup.ps1 first" -ForegroundColor Yellow
    & $python.Exe @($python.Args + @($program) + $args)
}
exit $LASTEXITCODE
