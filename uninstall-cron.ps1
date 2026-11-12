<#
.SYNOPSIS
    Removes the yt-automation scheduled task (stops all automation).

.DESCRIPTION
    Deletes the OCU-YTTV-CancelAddons scheduled task. Any run that is
    currently in progress will finish on its own; the next scheduled run
    will never start.

.EXAMPLE
    .\uninstall-cron.ps1
#>

$ErrorActionPreference = "Stop"

$taskName = "OCU-YTTV-CancelAddons"

$existing = schtasks /Query /TN $taskName 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Task '$taskName' was not found — nothing to remove."
    exit 0
}

Write-Host "Deleting scheduled task '$taskName' ..."
schtasks /Delete /TN $taskName /F

if ($LASTEXITCODE -ne 0) {
    throw "schtasks delete failed with exit code $LASTEXITCODE"
}

Write-Host "Done. Automatic execution is now stopped."
