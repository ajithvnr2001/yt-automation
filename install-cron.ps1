<#
.SYNOPSIS
    Installs the Windows Scheduled Task that runs yt-automation every
    <IntervalMinutes> minutes (default 15).

.DESCRIPTION
    Creates a scheduled task named OCU-YTTV-CancelAddons that invokes
    run-cancel.cmd (next to this script) every N minutes starting 15
    minutes from now. The task runs only when the user is logged in.

    To remove the task later, run uninstall-cron.ps1.

.EXAMPLE
    .\install-cron.ps1
    .\install-cron.ps1 -IntervalMinutes 15
#>
param(
    [int]$IntervalMinutes = 15
)

$ErrorActionPreference = "Stop"

$taskName = "OCU-YTTV-CancelAddons"
$cmd = Join-Path $PSScriptRoot "run-cancel.cmd"

if (-not (Test-Path $cmd)) {
    throw "run-cancel.cmd not found next to this script: $cmd"
}

$start = (Get-Date).AddMinutes(15).ToString("HH:mm")

Write-Host "Installing scheduled task '$taskName' ..."
schtasks /Create /TN $taskName /TR "`"$cmd`"" /SC MINUTE /MO $IntervalMinutes /ST $start /F

if ($LASTEXITCODE -ne 0) {
    throw "schtasks failed with exit code $LASTEXITCODE"
}

Write-Host ""
Write-Host "Done. Schedule overview:"
schtasks /Query /TN $taskName /FO LIST | Select-String -Pattern "TaskName|Next Run|Status"

Write-Host ""
Write-Host "The task will run every $IntervalMinutes minute(s). To stop it:"
Write-Host "  schtasks /Delete /TN `"$taskName`" /F"
Write-Host "(or run uninstall-cron.ps1)"
