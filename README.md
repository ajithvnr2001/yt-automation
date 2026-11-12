# yt-automation

**Automatically cancels pending YouTube TV add-ons** — one per scheduled run —
by driving Chrome through the OS accessibility tree (via
[open-computer-use](https://github.com/iFurySt/open-computer-use) / `ocu`).

This README is written for **complete beginners**. It explains, in depth:

1. what the tool does (and what it never does),
2. the exact **conditions** under which it acts,
3. the exact **behavior** for every scenario (behavior matrix),
4. everything you must **install** and set up, end to end,
5. how to **run it once**, how to **automate it**, and how to **stop it**,
6. how to **read the logs**, and
7. how to **troubleshoot** every known issue.

> ⚠️ **Important warning**
> This tool performs **real subscription cancellations** on your YouTube TV
> account. It is designed conservatively — it only ever clicks elements whose
> accessible name begins with `Remove`, then the confirmation button
> `Yes, cancel`. It never touches your base plan. Still, you are responsible
> for your own account; review what it does before enabling automation.

---

## Table of contents

- [1. What this tool does](#1-what-this-tool-does)
- [2. Conditions (when it acts and when it won't)](#2-conditions-when-it-acts-and-when-it-wont)
- [3. How it behaves (behavior matrix)](#3-how-it-behaves-behavior-matrix)
- [4. What you need to install](#4-what-you-need-to-install)
- [5. End-to-end setup (Windows)](#5-end-to-end-setup-windows)
- [6. Run it once (manual)](#6-run-it-once-manual)
- [7. Automate every 15 minutes](#7-automate-every-15-minutes)
- [8. Configuration (all options)](#8-configuration-all-options)
- [9. Logs — how to read them](#9-logs--how-to-read-them)
- [10. Stopping / uninstalling](#10-stopping--uninstalling)
- [11. Safety design](#11-safety-design)
- [12. Troubleshooting (in depth)](#12-troubleshooting-in-depth)
- [13. FAQ](#13-faq)
- [14. Project layout](#14-project-layout)
- [15. License](#15-license)

---

## 1. What this tool does

On the YouTube TV **Membership → Subscriptions** page
(`https://tv.youtube.com/settings/subscriptions`), every add-on you own is
listed with a **Remove** button. Add-ons you don't own show an **Add** button.

This tool:

1. opens/restores the Chrome window showing that page,
2. reads the page's accessibility tree (what screen readers see),
3. finds add-ons that currently show a **Remove** button,
4. clicks the first one,
5. waits for the confirmation dialog,
6. clicks **"Yes, cancel"**,
7. re-scans and repeats until nothing is left (or a per-run cap is reached),
8. logs everything to `cancel-log.txt`.

It is a **one-shot script** — by itself it runs once and exits. To run it
repeatedly, you wrap it in a Windows Scheduled Task (provided in this repo).

---

## 2. Conditions (when it acts and when it won't)

### 2.1 Hard requirements for a successful cancellation

| # | Condition | Why |
|---|---|---|
| 1 | **Windows 10/11** | Uses Windows accessibility APIs |
| 2 | **Node.js 18+** installed and on PATH | The script is Node.js |
| 3 | **`open-computer-use` (`ocu`) installed globally** | The driver that reads/clicks the UI |
| 4 | **Google Chrome running** | The script targets Chrome |
| 5 | **You are signed in to YouTube TV in Chrome** | The page only shows add-ons when signed in |
| 6 | **The Membership tab is open in Chrome** | `https://tv.youtube.com/settings/subscriptions` |
| 7 | **At least one add-on shows a `Remove` button** | Nothing to do otherwise |
| 8 | **YouTube's server accepts the cancellation** | Server may reject (see 2.2) |

> **Note on condition 6:** the script looks for a Chrome window whose title
> contains `YouTube TV`. Chrome tab titles look like
> `Membership - Settings - YouTube TV - Google Chrome`. If that tab is the
> only YouTube TV tab, the window title matches.

### 2.2 Conditions that BLOCK cancellation (script still runs, but can't finish)

| Condition | What you'll see | What the script does |
|---|---|---|
| YouTube server rejects | Log: `YouTube rejected the cancellation ("error canceling your membership")` | Stops the run; retries at next scheduled tick |
| No confirmation dialog appears | Log: `no 'Yes, cancel' dialog and item still present` | Stops the run; retries at next tick (defensive stop) |
| The add-on quietly disappears before dialog | Log: `no dialog but item gone — counted as cancelled` | Counts it as cancelled, continues |
| Chrome / tab not found | Log: `window restore: not-found` | Still attempts to scan (element actions can still work); may fail if the page isn't there |
| Another run in progress | Log: `another run already in progress — skipping this tick` | Skips, waits for next tick |
| No Remove buttons at all | Log: `no pending Remove buttons found — nothing to do` | Exits quietly (code 0) |
| `ocu` call times out | Log: `ocu call failed: ... timed out ...` | Retries the state read up to 3×; then aborts the run |

### 2.3 What it NEVER does

- ❌ Never clicks **Add** buttons.
- ❌ Never touches your **base YouTube TV plan** (it has no Remove button, so it is never matched).
- ❌ Never presses random keyboard shortcuts or moves your mouse.
- ❌ Never tries more than **one** cancellation per run by default.
- ❌ Never retries within the same run after a failed confirmation.
- ❌ Never runs without your login session (Task Scheduler runs it as you).

---

## 3. How it behaves (behavior matrix)

### 3.1 The per-run lifecycle

```
Run starts
  │
  ├─ 1. Acquire lock (skip if another run is active)
  ├─ 2. Restore Chrome's "YouTube TV" window (best effort)
  ├─ 3. get_app_state → parse accessibility tree
  ├─ 4. Find buttons named "Remove …"
  │       ├─ none → log "nothing to do" → exit 0
  │       └─ some → pick the first one
  ├─ 5. Click Remove (batched with fresh state in the same process)
  ├─ 6. Wait 2s, then poll for the confirmation dialog (up to ~20s)
  │       ├─ "Yes, cancel" found → click it
  │       ├─ YouTube rejection toast found → log, stop run (retry next tick)
  │       ├─ item disappeared → count as cancelled
  │       └─ item still present → log, stop run (retry next tick)
  ├─ 7. Count the cancellation; wait 4s; loop back to step 3
  └─ 8. Stop when: nothing pending, or per-run cap reached, or time cap reached
```

### 3.2 Behavior by scenario

| Scenario | Behavior |
|---|---|
| 1 pending add-on, normal dialog | Remove → dialog → "Yes, cancel" → `cancellation submitted` |
| Several pending add-ons | One is cancelled per run (`MAX_REMOVALS=1`); the next tick handles the next |
| YouTube rejects (trial add-ons) | Logs the rejection, stops. Next tick tries again. Repeats indefinitely |
| No dialog but item gone | Counted as cancelled (success) — protects against missed dialogs |
| No dialog and item still there | Defensive stop, next tick retries |
| Nothing pending | Quiet exit, no clicks |
| Chrome window minimized/closed | Window restore may say `not-found`; scanning may still work, or the run logs a state error and aborts safely |
| Two runs overlap | Lock file → second run logs `skipping this tick` and exits |
| Script killed mid-run while lock stale | Lock auto-stolen after 30 minutes |
| `ocu` hangs | 90s per-call timeout; whole process tree is force-killed; run aborts safely |
| `get_app_state` runtime timeout | Retried up to 3 times with 3s pauses |

### 3.3 Timing profile of a typical successful run

| Step | Approx. time |
|---|---|
| Window restore | 1–3 s |
| State read | 10–20 s |
| Click Remove | ~10–30 s |
| Wait + poll for dialog | 2–20 s |
| Click "Yes, cancel" | ~10–30 s |
| Post-confirm wait + final rescan | ~10–20 s |
| **Total** | **~1–2 minutes** |

---

## 4. What you need to install

| Requirement | How to check | Where to get it |
|---|---|---|
| Windows 10/11 | Settings → System → About | — |
| Node.js 18+ | `node --version` | https://nodejs.org (LTS) |
| npm (comes with Node.js) | `npm --version` | — |
| Git (optional, for cloning) | `git --version` | https://git-scm.com |
| Google Chrome | Installed app | https://www.google.com/chrome |
| `open-computer-use` | `ocu --version` | `npm i -g open-computer-use` |
| A YouTube TV account | Signed in to tv.youtube.com | google account |

---

## 5. End-to-end setup (Windows)

### Step 5.1 — Install Node.js

1. Download the **LTS** installer from https://nodejs.org.
2. Run it. Accept defaults (make sure **"Add to PATH"** is checked).
3. Open a **new** PowerShell window and verify:
   ```powershell
   node --version    # e.g. v22.x.x
   npm --version     # e.g. 11.x.x
   ```

### Step 5.2 — Install the computer-use driver

```powershell
npm i -g open-computer-use
ocu --version        # e.g. 1.1.4
ocu capabilities --json   # optional: confirms native runtime availability
```

### Step 5.3 — Get this project

```powershell
git clone https://github.com/ajithvnr2001/yt-automation.git D:\yt-automation
cd D:\yt-automation
```

(If you don't use Git, download the ZIP from the repo page and extract it.)

### Step 5.4 — Open your YouTube TV Membership page

1. Open **Chrome**.
2. Go to `https://tv.youtube.com/` and sign in.
3. Open `https://tv.youtube.com/settings/subscriptions`.
4. Keep this tab open (you may keep using Chrome normally).

> The script restores the window with "YouTube TV" in its title when it runs.

### Step 5.5 — Verify the installation (dry run)

```powershell
$env:OCU_SCAN_ONLY = "1"
node .\cancel-addons.mjs
```

Expected output (example):

```
[2026-11-12T10:47:21Z] === run start (scanOnly=true) ===
[2026-11-12T10:47:23Z] window restore: restored
[2026-11-12T10:47:38Z] SCAN_ONLY: found 2 pending removal(s):
[2026-11-12T10:47:38Z]   - idx 485 => Acorn TV
[2026-11-12T10:47:38Z]   - idx 689 => Gaia
[2026-11-12T10:47:38Z] === run end (removals=0) ===
```

If it says `no pending Remove buttons found`, you have nothing to cancel right
now — which is fine.

---

## 6. Run it once (manual)

```powershell
Remove-Item Env:OCU_SCAN_ONLY   # make sure scan-only is OFF
node .\cancel-addons.mjs
```

That cancels **one** add-on. Run it again to cancel the next one.

---

## 7. Automate every 15 minutes

### Option A — one-liner installer (recommended)

```powershell
powershell -ExecutionPolicy Bypass -File .\install-cron.ps1 -IntervalMinutes 15
```

Creates scheduled task **`OCU-YTTV-CancelAddons`**:

- runs `run-cancel.cmd` (→ `cancel-addons.mjs`)
- every **15 minutes**
- starting **15 minutes from now**
- only while you're logged on

Verify:

```powershell
schtasks /Query /TN "OCU-YTTV-CancelAddons" /FO LIST
```

### Option B — Task Scheduler GUI

1. Press <kbd>Win</kbd>, type "Task Scheduler", open it.
2. **Create Task…**
3. General: Name `OCU-YTTV-CancelAddons`; "Run only when user is logged on".
4. Triggers: **New…** → "Daily" → check **"Repeat every"** → `15 minutes` → "for a duration of: Indefinitely".
5. Actions: **New…** → Action "Start a program" → Program/script: `D:\yt-automation\run-cancel.cmd`.
6. OK → OK.

### What each tick does

1. Restores Chrome's YouTube TV window (briefly brings it to front).
2. Scans for Remove buttons.
3. Cancels exactly one (if any) — or logs "nothing to do" and exits quietly.

---

## 8. Configuration (all options)

All settings are **optional environment variables**.

| Variable | Default | Meaning |
|---|---|---|
| `OCU_BIN` | npm-global `ocu` bin | Path to the `ocu` CLI entry; override if `ocu` isn't found |
| `OCU_APP` | `Google Chrome` | App name as seen by `ocu` |
| `OCU_MAX_REMOVALS` | `1` | Max cancellations per run |
| `OCU_RUN_TIMEOUT_MS` | `180000` | Hard time cap per run (ms) |
| `OCU_SCAN_ONLY` | unset | `1` = scan & report only, never click |
| `OCU_AUTOMATION_DIR` | script folder | Where logs/lock live |

Example — allow up to 3 per run, scan only:

```powershell
$env:OCU_MAX_REMOVALS = "3"
$env:OCU_SCAN_ONLY   = "1"
node .\cancel-addons.mjs
```

On Windows, you can set these permanently for the task by adding them to the
cmd wrapper or using `setx` (advanced).

---

## 9. Logs — how to read them

Every run appends timestamped lines to **`cancel-log.txt`** in the project
folder.

```powershell
Get-Content .\cancel-log.txt -Tail 30
```

| Log line | Meaning |
|---|---|
| `=== run start (...)` | Run begins |
| `window restore: restored` | Chrome's YouTube TV window brought to front |
| `window restore: not-found` | No matching window found; script still tries to scan |
| `clicking Remove for: X (idx N)` | About to click Remove for add-on X |
| `confirming with 'Yes, cancel' (idx N)` | Confirmation dialog found, clicking |
| `cancellation submitted for: X (total this run: N)` | ✅ Success — server accepted |
| `no dialog but item gone — counted as cancelled: X` | ✅ Item disappeared before dialog; counted |
| `no pending Remove buttons found — nothing to do` | ✅ Quiet tick — nothing pending |
| `YouTube rejected the cancellation ("error canceling your membership")` | ❌ Server refused; will retry next tick |
| `no 'Yes, cancel' dialog and item still present — stopping this run` | ❌ Defensive stop; retry next tick |
| `another run already in progress — skipping this tick` | Lock held by another run |
| `state error: ocu call failed: ...` | CLI failure (detail included) |
| `ocu call failed: ... timed out ...` | Transient runtime timeout (auto-retried ×3) |
| `=== run end (removals=N) ===` | Run finished; N cancellations this run |

Exit codes: `0` = clean end; `1` = ended with a hard error and zero removals.

---

## 10. Stopping / uninstalling

```powershell
# One-liner:
powershell -ExecutionPolicy Bypass -File .\uninstall-cron.ps1

# …or manually:
schtasks /Delete /TN "OCU-YTTV-CancelAddons" /F

# Pause until next manual run:
schtasks /Run /TN "OCU-YTTV-CancelAddons"   # run once now
```

To kill a stuck run immediately:

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'cancel-addons' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

---

## 11. Safety design

| Mechanism | What it prevents |
|---|---|
| Strict button-name matching (`Remove …` only) | Never clicks "Add" or unrelated buttons |
| Strict confirmation matching (`Yes, cancel`) | Never confirms the wrong thing |
| Never matches the base plan | Base plan untouched |
| One cancellation per run | Contained blast radius; paced behavior |
| No same-run retry | No spam loops on a stuck page |
| Lock file | No concurrent runs fighting over Chrome |
| Timeouts + process-tree kill | A hung `ocu` call can't freeze the script forever |
| Scan-only mode (`OCU_SCAN_ONLY=1`) | Practice/verify without touching anything |
| Full logging | Every action is auditable |

---

## 12. Troubleshooting (in depth)

### 12.1 `ocu call failed: No app state is available for Google Chrome`
**Why:** action tools require a `get_app_state` in the same process; the script
always batches that, so this usually means Chrome isn't running or the target
page/window is gone.
**Fix:** open Chrome, sign in to YouTube TV, open the Membership page, re-run.

### 12.2 `Windows runtime timed out after 30s`
**Why:** transient slowness of the native accessibility runtime.
**Fix:** automatic retry (3×) usually handles it; check network; re-run.

### 12.3 `There was an error canceling your membership. Please try again later, or contact us.`
**Why:** YouTube's **server** rejected the cancellation — most often for
**trial add-ons**. The script can't fix server-side refusals.
**Behavior:** it logs the rejection, stops, and retries on the next tick.
**What you can do:** retry later (the tick may succeed), cancel via YouTube
support/chat, or let the trial expire on its own.

### 12.4 The script keeps saying `no 'Yes, cancel' dialog ... item still present`
**Why:** the remove click didn't produce a confirmable dialog (typically the
server rejection in 12.3).
**Fix:** check the log for the rejection message; see 12.3.

### 12.5 The run hangs / never finishes
**Why:** an `ocu` child wedged (older versions lacked tree-kill).
**Fix:** current code kills the whole tree on timeout. If you see a stuck
process anyway, kill it (see §10). Update the script to the latest version.

### 12.6 Nothing appears in the log
**Why:** the wrapper's `node` lookup failed, or the task runs under a
different user.
**Fix:** run `.\run-cancel.cmd` manually to see the error; confirm Node.js is
on PATH for the account running the task.

### 12.7 Chrome window "pops up" every 15 minutes
**Expected.** The script restores the YouTube TV window to interact with it.
If this bothers you, reduce frequency or stop automation (§10).

### 12.8 `schtasks` shows an old "Next Run Time"
**Why:** missed runs are skipped when the PC is off; the next 15-minute mark
takes over.

### 12.9 `Get-Content` log is huge
Logs grow unbounded. Trim them periodically:

```powershell
Get-Content .\cancel-log.txt -Tail 200 | Set-Content .\cancel-log.txt
```

---

## 13. FAQ

**Q: Will this cancel my base YouTube TV plan?**
No — the base plan has no Remove button and is never matched.

**Q: How many add-ons are cancelled per run?**
One by default. Set `OCU_MAX_REMOVALS` to change that.

**Q: Does it need OpenCode (or this chat) to be open?**
No — it runs standalone via Task Scheduler.

**Q: Does it need my PC to be on?**
Yes. Missed ticks are skipped; the next tick runs at the next 15-minute mark.

**Q: Is it safe to use while I'm working?**
The only visible effect is the Chrome window briefly coming to the front.

**Q: What if I delete the repo folder?**
The task points at `run-cancel.cmd`; if that path disappears, the task will
fail — delete the task too (see §10).

**Q: Can I use it on macOS/Linux?**
The window-restore and Task Scheduler parts are Windows-specific. The core
logic is portable, but this repo targets Windows.

**Q: Where are logs?**
`cancel-log.txt` in the project folder.

---

## 14. Project layout

```
yt-automation/
├── cancel-addons.mjs      # The automation engine (all logic)
├── run-cancel.cmd         # Wrapper for manual runs & Task Scheduler
├── install-cron.ps1       # One-click 15-min scheduled-task installer
├── uninstall-cron.ps1     # One-click uninstaller
├── cancel-log.txt         # Created automatically — run history
├── run.lock               # Created automatically — concurrency lock
└── README.md              # This file
```

---

## 15. License

MIT — use, modify, share freely. You are responsible for your own account
actions.
