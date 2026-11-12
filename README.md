# yt-automation

**Automatically cancels pending YouTube TV add-ons** (subscriptions on your
YouTube TV Membership page) — one per scheduled run — with zero manual
intervention.

Built on top of [open-computer-use](https://github.com/iFurySt/open-computer-use)
(`ocu`), which drives Chrome through the OS accessibility tree. The script
*reads* the page, finds add-ons that show a **Remove** button, clicks
**Remove**, confirms with **"Yes, cancel"**, and moves on.

> ⚠️ **What this does (read before using):**
> This tool performs **real subscription cancellations** on your YouTube TV
> account. It only touches buttons explicitly named `Remove …` and the
> confirmation button `Yes, cancel`. It **never** touches your base YouTube TV
> plan. Still — verify the page yourself before enabling automation.

---

## Table of contents

1. [How it works](#how-it-works)
2. [What you need](#what-you-need)
3. [One-time setup](#one-time-setup)
4. [Run it once (manual)](#run-it-once-manual)
5. [Automate every 15 minutes (Windows Task Scheduler)](#automate-every-15-minutes-windows-task-scheduler)
6. [Configuration](#configuration)
7. [Logs](#logs)
8. [Changing / stopping automation](#changing--stopping-automation)
9. [Troubleshooting](#troubleshooting)
10. [FAQ](#faq)
11. [Project layout](#project-layout)
12. [License](#license)

---

## How it works

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────────┐
│ Windows Task     │ ──▶│ run-cancel.cmd   │ ──▶│ cancel-addons.mjs      │
│ Scheduler (every │     │ (wrapper)        │     │ (the automation logic) │
│ 15 min)          │     └──────────────────┘     └───────────┬─────────────┘
└─────────────────┘                                         │
                                                            ▼
                              ┌────────────────────────────────────────────┐
                              │ For each run:                             │
                              │ 1. Restore Chrome's "YouTube TV" window    │
                              │ 2. Read the page's accessibility tree      │
                              │ 3. Find add-ons with a "Remove" button     │
                              │ 4. Click Remove → wait for dialog          │
                              │ 5. Click "Yes, cancel"                     │
                              │ 6. Rescan; stop when nothing is left       │
                              └────────────────────────────────────────────┘
```

### The safety rules (hard-coded)

| Rule | Why |
|---|---|
| Only clicks elements whose accessible name starts with `Remove` | Can't accidentally hit "Add" or other buttons |
| Only clicks the `Yes, cancel` confirmation | Can't confirm the wrong thing |
| Never touches the base plan | The base plan has no Remove button, so it's simply never matched |
| One cancellation per run (`MAX_REMOVALS=1`) | Each 15-min tick removes exactly one |
| No retry inside a run | If no dialog appears, the run stops and the *next* tick retries |
| Concurrency lock | Two runs can never overlap and fight over Chrome |
| Timeouts + process-tree kill | A stuck call can never hang a run forever |

### Why "one per 15 min"?

YouTube sometimes rejects a cancellation on the server side (you'll see
`There was an error canceling your membership` in the logs). Forcing retries
immediately doesn't help and can look like spam. The designed behaviour is:
**try once per tick, pause, and automatically try again at the next tick.**

---

## What you need

| Requirement | Notes |
|---|---|
| **Windows 10/11** | The automation uses Windows accessibility APIs |
| **Node.js 18+** | Get it from https://nodejs.org (LTS). Verify with `node --version` |
| **Google Chrome** | The script targets Chrome's YouTube TV Membership tab |
| **A YouTube TV account** | With add-ons (paid or trial) you want to cancel |
| **npm** | Ships with Node.js |

---

## One-time setup

### 1. Install `open-computer-use` (the driver)

```powershell
npm i -g open-computer-use
```

Verify it works:

```powershell
ocu --version
# → 1.x.x
```

> No extra permissions are needed on Windows (macOS would require
> Accessibility / Screen Recording grants — not applicable here).

### 2. Get the project

Clone (or copy) this repository to any folder, e.g.:

```powershell
git clone https://github.com/<you>/yt-automation.git D:\yt-automation
cd D:\yt-automation
```

### 3. Open your YouTube TV Membership page

In Chrome, sign in to YouTube TV and open:

```
https://tv.youtube.com/settings/subscriptions
```

Leave that tab open. The automation looks for a Chrome window whose title
contains `YouTube TV` (the tab title usually reads
`Membership - Settings - YouTube TV - Google Chrome`).

---

## Run it once (manual)

From a PowerShell prompt, in the project folder:

```powershell
# Safety first: scan only, don't click anything.
$env:OCU_SCAN_ONLY = "1"
node .\cancel-addons.mjs
```

You should see output like:

```
[2026-11-12T10:13:21Z] SCAN_ONLY: found 2 pending removal(s):
[2026-11-12T10:13:21Z]   - idx 485 => Acorn TV
[2026-11-12T10:13:21Z]   - idx 686 => Gaia
```

Then run the real thing (removes **one** add-on):

```powershell
Remove-Item Env:OCU_SCAN_ONLY
node .\cancel-addons.mjs
```

---

## Automate every 15 minutes (Windows Task Scheduler)

Simplest way — run the included installer (from the project folder):

```powershell
powershell -ExecutionPolicy Bypass -File .\install-cron.ps1 -IntervalMinutes 15
```

This creates a scheduled task named **`OCU-YTTV-CancelAddons`** that:

- runs `run-cancel.cmd` (→ `cancel-addons.mjs`)
- every **15 minutes**
- starting **15 minutes from now**
- only while you're logged in to Windows

You can also create it manually in **Task Scheduler**:

| Field | Value |
|---|---|
| Program/script | `D:\yt-automation\run-cancel.cmd` |
| Trigger | Daily → repeat every **15 minutes**, indefinitely |
| (optional) Run only when user is logged on | default |

### What happens on each tick

1. Chrome's YouTube TV window is restored/brought to the front (briefly).
2. The script scans the page.
3. If a **Remove** button exists → click → confirm → log "cancellation submitted".
4. If nothing is pending → logs `no pending Remove buttons found — nothing to do` and exits quietly (exit code 0).
5. If YouTube rejects → logs the rejection, stops, tries again next tick.

---

## Configuration

All settings are **optional** environment variables. Defaults are sensible.

| Variable | Default | Meaning |
|---|---|---|
| `OCU_BIN` | npm-global `ocu` bin | Path to the ocu CLI entry (only change if `ocu` isn't on PATH) |
| `OCU_APP` | `Google Chrome` | App name as seen by `ocu` |
| `OCU_MAX_REMOVALS` | `1` | Max cancellations per run |
| `OCU_RUN_TIMEOUT_MS` | `180000` | Hard time cap per run (ms) |
| `OCU_SCAN_ONLY` | unset | `1` = scan & report only, never click |
| `OCU_AUTOMATION_DIR` | script folder | Where logs/lock live |

Example:

```powershell
$env:OCU_MAX_REMOVALS = "3"
$env:OCU_SCAN_ONLY   = "1"
node .\cancel-addons.mjs
```

---

## Logs

Every run appends a timestamped line to **`cancel-log.txt`** in the project
folder. Read the latest entries with:

```powershell
Get-Content .\cancel-log.txt -Tail 30
```

Log lines you will see:

| Line | Meaning |
|---|---|
| `window restore: restored` | Chrome's YouTube TV window was brought to front |
| `clicking Remove for: <Add-on> (idx N)` | About to click Remove |
| `confirming with 'Yes, cancel' (idx N)` | Confirmation dialog found & clicked |
| `cancellation submitted for: <Add-on>` | Success (server accepted) |
| `no pending Remove buttons found` | Nothing to do — quiet tick |
| `YouTube rejected the cancellation (...)` | Server refusal — will retry next tick |
| `no 'Yes, cancel' dialog and item still present — stopping this run` | Defensive stop — retry next tick |

---

## Changing / stopping automation

```powershell
# Stop automatic runs (delete the scheduled task):
powershell -ExecutionPolicy Bypass -File .\uninstall-cron.ps1

# …or manually:
schtasks /Delete /TN "OCU-YTTV-CancelAddons" /F

# Pause temporarily (keeps the task but prevents next run):
schtasks /End /TN "OCU-YTTV-CancelAddons"

# Re-enable:
schtasks /Run /TN "OCU-YTTV-CancelAddons"
```

---

## Troubleshooting

### "ocu call failed: No app state is available for Google Chrome"
The driver needs a fresh `get_app_state` before action tools. The script
always batches state + action in one process, so if you still see this it
usually means Chrome isn't running or the window is gone. Open the YouTube TV
Membership tab and run again.

### "Windows runtime timed out after 30s"
Transient server/runtime slowness. The script retries up to 3× automatically.
If it persists, check your connection, then try again.

### "There was an error canceling your membership. Please try again later."

YouTube's server **rejected** the cancellation (common for trial add-ons).
The script will keep trying every 15 minutes as designed. If it never
succeeds, the add-on may need to be cancelled through YouTube support/chat,
or after the trial expires on its own.

### The run hangs / never finishes
Every external call has a hard timeout, and the process tree is force-killed
on timeout. If you still see a stuck process, kill it manually:

```powershell
Get-Process node | Where-Object { $_.MainWindowTitle -eq '' } | Stop-Process -Force
```

### Clock shows old "Next Run" time
Task Scheduler skips missed runs when the PC is off — the next trigger simply
happens at the following 15-minute mark.

### "node.exe not found" in the cmd wrapper
Install Node.js (https://nodejs.org) and reopen the terminal so `node` is on
PATH.

---

## FAQ

**Q: Will this cancel my base YouTube TV plan?**
No. The base plan has no Remove button, and the script only matches buttons
named `Remove …`.

**Q: How many add-ons get cancelled per run?**
One, by default. Set `OCU_MAX_REMOVALS` higher if you want more per tick.

**Q: Do I need to keep my PC on?**
Yes — the scheduled task runs on your machine. If it's off during a tick, the
tick is skipped and it simply runs at the next 15-minute mark.

**Q: Does it need OpenCode or this repo to be "open"?**
No. The scheduled task runs standalone (Node + `ocu`). OpenCode is not
involved.

**Q: Is it safe to run while I'm using the PC?**
It restores the Chrome YouTube TV window to the foreground for a few seconds
each tick. That's the only visible effect.

**Q: Where are the logs?**
`cancel-log.txt` in the project folder.

---

## Project layout

```
yt-automation/
├── cancel-addons.mjs      # The automation script (all logic)
├── run-cancel.cmd         # Wrapper used by Task Scheduler
├── install-cron.ps1       # One-click scheduled-task installer
├── uninstall-cron.ps1     # One-click scheduled-task uninstaller
├── cancel-log.txt         # Created automatically: run history
└── README.md              # This file
```

---

## License

MIT — use it, change it, share it. You are responsible for your own account
actions.
