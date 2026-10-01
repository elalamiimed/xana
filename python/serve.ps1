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
#   XANA_STT_MODEL    Whisper model                       (default base)
#   XANA_STT_BACKEND  auto | faster-whisper | whisper     (default auto)
#
# Nothing here sets XANA_STT_HOST. Binding anywhere but loopback publishes an
# unauthenticated transcription service to the network, and that is a decision
# for the person typing the command, not for a convenience script.

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$program = Join-Path $here "xana_stt.py"

if (-not (Test-Path -LiteralPath $program)) {
    Write-Host "xana_stt.py is not next to serve.ps1 (looked in $here)."
    exit 1
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

& $python.Exe @($python.Args + @($program) + $args)
exit $LASTEXITCODE
