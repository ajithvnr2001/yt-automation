#!/usr/bin/env node
/**
 * yt-automation — YouTube TV add-on cancellation automation
 * ==========================================================
 * Scans the YouTube TV "Membership → Subscriptions" page in Chrome and
 * cancels pending add-ons (items that show a "Remove" button), one per run.
 *
 * Flow per run:
 *   1. Restore the Chrome window that has the YouTube TV Membership page.
 *   2. Read the accessibility tree via the `ocu` CLI (open-computer-use).
 *   3. Find every element whose accessible button label starts with "Remove".
 *   4. For the first one: click it, wait for the confirmation dialog,
 *      click "Yes, cancel", wait for processing, then rescan.
 *   5. Stop when no "Remove" buttons remain (or hit run time/iteration caps).
 *
 * Safety:
 *   - It only ever clicks buttons whose accessible name starts with "Remove"
 *     and the confirmation button "Yes, cancel". Nothing else is touched.
 *   - The base YouTube TV plan is never touched (it has no Remove button).
 *   - No retry within a run: if the confirmation dialog does not appear
 *     (e.g. YouTube rejects the cancellation), the run stops and the next
 *     scheduled 15-minute tick tries again.
 *   - Concurrency-safe: a lock file prevents overlapping runs; stale locks
 *     (>30 min) are stolen automatically.
 *   - Every step is logged to cancel-log.txt.
 *
 * Configuration (all optional, via environment variables):
 *   OCU_BIN                 Path to the `ocu` CLI entry (default: the npm-global
 *                           open-computer-use bin on this machine).
 *   OCU_APP                 App name as seen by ocu (default: "Google Chrome").
 *   OCU_MAX_REMOVALS        Max cancellations per run (default: 1).
 *   OCU_RUN_TIMEOUT_MS      Hard time cap for a run (default: 180000).
 *   OCU_SCAN_ONLY           Set to 1 to only scan and report, never click.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, appendFileSync, mkdirSync, existsSync, statSync, unlinkSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---- paths (portable: everything lives next to this script by default) ----
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AUTOMATION_DIR = process.env.OCU_AUTOMATION_DIR || SCRIPT_DIR;
const LOG_FILE = join(AUTOMATION_DIR, "cancel-log.txt");
const LOCK_FILE = join(AUTOMATION_DIR, "run.lock");
const TMP_CALLS = join(tmpdir(), `ocu-calls-${process.pid}.json`);

const NODE = process.execPath;
const OCU_CLI = process.env.OCU_BIN || "C:\\Users\\ajith\\AppData\\Roaming\\npm\\node_modules\\open-computer-use\\bin\\ocu";
const APP = process.env.OCU_APP || "Google Chrome";

const SCAN_ONLY = process.env.OCU_SCAN_ONLY === "1";
const MAX_REMOVALS_PER_RUN = Number(process.env.OCU_MAX_REMOVALS || 1);
const RUN_TIMEOUT_MS = Number(process.env.OCU_RUN_TIMEOUT_MS || 180000);
const CALL_TIMEOUT_MS = 90000; // each ocu call must finish within 90s
const SLEEP_BEFORE_CONFIRM_MS = 2000;
const SLEEP_AFTER_CONFIRM_MS = 4000;
const CONFIRM_POLL_ATTEMPTS = 5;
const CONFIRM_POLL_INTERVAL_MS = 4000;
const STATE_RETRY_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch { /* ignore */ }
}

function sleep(ms) {
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Start-Sleep -Milliseconds ${ms}`], { stdio: "ignore", timeout: 30000 });
  } catch { /* ignore */ }
}

// ---- concurrency guard: only one run at a time ----
function acquireLock() {
  try {
    const fd = openSync(LOCK_FILE, "wx");
    closeSync(fd);
    return true;
  } catch (e) {
    try {
      const age = Date.now() - statSync(LOCK_FILE).mtimeMs;
      if (age > 30 * 60 * 1000) { // stale lock (>30 min): steal it
        unlinkSync(LOCK_FILE);
        const fd = openSync(LOCK_FILE, "wx");
        closeSync(fd);
        return true;
      }
    } catch { /* race; fall through */ }
    return false;
  }
}
function releaseLock() {
  try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Window restore (Win32) — brings the Chrome YouTube TV window to the front
// ---------------------------------------------------------------------------

function restoreYttvWindow() {
  const ps = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinRestore {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
$done = $false
$cb = [WinRestore+EnumWindowsProc]{ param($h,$l)
  if ([WinRestore]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][WinRestore]::GetWindowText($h, $sb, 512)
    if ($sb.ToString() -match 'YouTube TV') {
      [void][WinRestore]::ShowWindowAsync($h, 9)
      Start-Sleep -Milliseconds 300
      [void][WinRestore]::SetForegroundWindow($h)
      $script:done = $true
      return $false
    }
  }
  return $true
}
[void][WinRestore]::EnumWindows($cb, [IntPtr]::Zero)
if ($done) { 'restored' } else { 'not-found' }`;
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 30000 }).trim();
  } catch (e) {
    return "restore-error";
  }
}

// ---------------------------------------------------------------------------
// ocu CLI bridge
// ---------------------------------------------------------------------------

function killTree(pid) {
  try {
    execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", timeout: 10000 });
  } catch { /* ignore */ }
}

/**
 * Run one or more `ocu call` tools in a single process.
 * IMPORTANT: action tools (click, press_key, ...) require a get_app_state
 * call *in the same process* first — that is why clickElement() batches them.
 */
function callTools(calls) {
  writeFileSync(TMP_CALLS, JSON.stringify(calls));
  const res = spawnSync(NODE, [OCU_CLI, "call", "--calls-file", TMP_CALLS], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: CALL_TIMEOUT_MS,
  });
  if (res.error || res.status !== 0) {
    // Force-kill the whole process tree so no stray child can wedge the run.
    if (res.pid) killTree(res.pid);
    const detail = (res.stdout && String(res.stdout).slice(0, 2000)) || (res.error && res.error.message) || ("exit " + res.status);
    throw new Error("ocu call failed: " + detail);
  }
  const raw = res.stdout;
  const parsed = JSON.parse(raw);
  return parsed.map((entry) => {
    const res2 = entry.result || {};
    const text = (res2.content && res2.content[0] && res2.content[0].text) || "";
    return { text, isError: !!res2.isError };
  });
}

function appState() {
  let lastErr = null;
  for (let attempt = 0; attempt < STATE_RETRY_ATTEMPTS; attempt++) {
    try {
      const results = callTools([{ tool: "get_app_state", args: { app: APP, include_screenshot: false, text_limit: "max" } }]);
      return results[0];
    } catch (e) {
      lastErr = e;
      // Transient "runtime timed out" is retryable; give the native runtime a moment.
      if (/timed out/i.test(String(e.message))) {
        sleep(3000);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Accessibility-tree parsing (the `ocu` CLI prints the tree as text)
// ---------------------------------------------------------------------------

function findRemoveButtons(text) {
  const re = /^\s*(\d+)\s+button\s+Remove\s+(.+?)\s+Secondary Actions/;
  const found = [];
  for (const line of text.split("\n")) {
    const m = line.match(re);
    if (m) found.push({ idx: m[1], label: m[2].trim() });
  }
  return found;
}

function findYesCancel(text) {
  const re = /^\s*(\d+)\s+button\s+Yes, cancel\b/;
  for (const line of text.split("\n")) {
    const m = line.match(re);
    if (m) return m[1];
  }
  return null;
}

// Action tools require a get_app_state call in the same process first,
// so every action is batched with a fresh state snapshot.
function clickElement(idx) {
  const results = callTools([
    { tool: "get_app_state", args: { app: APP, include_screenshot: false, text_limit: "max" } },
    { tool: "click", args: { app: APP, element_index: idx } },
  ]);
  return results[1];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(AUTOMATION_DIR, { recursive: true });
  log("=== run start (scanOnly=" + SCAN_ONLY + ") ===");

  if (!acquireLock()) {
    log("another run already in progress — skipping this tick");
    return;
  }

  try {
    const restore = restoreYttvWindow();
    log("window restore: " + restore);

    const started = Date.now();
    let removals = 0;
    let lastError = null;

    while (Date.now() - started < RUN_TIMEOUT_MS && removals < MAX_REMOVALS_PER_RUN) {
      let st;
      try {
        st = appState();
      } catch (e) {
        lastError = "state error: " + e.message;
        log(lastError);
        break;
      }
      if (!st || st.isError || !st.text) {
        lastError = "empty/unreadable state";
        log(lastError);
        break;
      }

      const buttons = findRemoveButtons(st.text);
      if (buttons.length === 0) {
        log("no pending Remove buttons found — nothing to do");
        break;
      }

      if (SCAN_ONLY) {
        log("SCAN_ONLY: found " + buttons.length + " pending removal(s):");
        for (const b of buttons) log("  - idx " + b.idx + " => " + b.label);
        break;
      }

      const target = buttons[0];
      log("clicking Remove for: " + target.label + " (idx " + target.idx + ")");
      try {
        clickElement(target.idx);
      } catch (e) {
        lastError = "click error: " + e.message;
        log(lastError);
        break;
      }

      sleep(SLEEP_BEFORE_CONFIRM_MS);

      // Poll for the confirmation dialog; it may take a few seconds to appear.
      let yesIdx = null;
      let st2 = null;
      for (let attempt = 0; attempt < CONFIRM_POLL_ATTEMPTS; attempt++) {
        try { st2 = appState(); } catch (e) { lastError = "state2 error: " + e.message; log(lastError); break; }
        if (st2 && !st2.isError && /error canceling your membership/i.test(st2.text)) {
          log("YouTube rejected the cancellation (\"error canceling your membership\") — will retry on next 15-minute tick: " + target.label);
          break;
        }
        yesIdx = st2 && !st2.isError ? findYesCancel(st2.text) : null;
        if (yesIdx) break;
        sleep(CONFIRM_POLL_INTERVAL_MS);
      }
      if (lastError) break;

      if (!yesIdx) {
        // No dialog: check whether the item quietly disappeared (already removed).
        const stillThere = st2 && !st2.isError ? findRemoveButtons(st2.text).some((b) => b.label === target.label) : true;
        if (!stillThere) {
          removals += 1;
          log("no dialog but item gone — counted as cancelled: " + target.label + " (total this run: " + removals + ")");
          continue;
        }
        // No retry within this run: stop and let the next 15-minute tick try again.
        log("no 'Yes, cancel' dialog and item still present — stopping this run, will retry on next 15-minute tick: " + target.label);
        break;
      }

      log("confirming with 'Yes, cancel' (idx " + yesIdx + ")");
      try {
        clickElement(yesIdx);
      } catch (e) {
        lastError = "confirm click error: " + e.message;
        log(lastError);
        break;
      }

      removals += 1;
      log("cancellation submitted for: " + target.label + " (total this run: " + removals + ")");
      sleep(SLEEP_AFTER_CONFIRM_MS);
    }

    if (lastError) log("run ended with issue: " + lastError);
    log("=== run end (removals=" + removals + ") ===");
    process.exitCode = lastError && removals === 0 ? 1 : 0;
  } finally {
    releaseLock();
  }
}

main().catch((e) => {
  log("fatal: " + (e && e.stack ? e.stack : String(e)));
  process.exitCode = 1;
});
