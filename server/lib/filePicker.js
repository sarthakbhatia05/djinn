// server/lib/filePicker.js
//
// Cross-platform "pick a file" dialog — the single-file counterpart to
// folderPicker.js. Same structure and same platform quirks apply here:
//   win32  -> PowerShell System.Windows.Forms.OpenFileDialog
//   darwin -> osascript `choose file`
//   linux  -> zenity, falling back to kdialog, falling back to null
//
// Resolves the chosen absolute path, or null when the user cancels or no
// dialog tool is available. Rejects only on real failures.
const { spawn } = require('child_process');

// A file path can never be literally this, so it is safe as an out-of-band signal.
const CANCEL_SENTINEL = '__CANCELLED__';

// A dialog nobody can see would otherwise block the HTTP request forever —
// requestTimeout/headersTimeout are 0 (see CLAUDE.md), so nothing else would
// ever cut it loose, and each retry click would strand another powershell.exe.
const DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;

// OpenFileDialog has no TopMost property, and an ownerless ShowDialog()
// cannot take foreground while the browser holds the Windows foreground lock
// (the user's click on the attach button is exactly what arms that lock). The
// dialog then opens *behind* the browser and looks like nothing happened.
// Giving it a topmost owner form makes it inherit that z-order instead.
//
// The explicit cancel sentinel matters because PowerShell exits 0 even when the
// script errors, so "no output" cannot otherwise be told apart from a cancel.
const PICKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $owner = New-Object System.Windows.Forms.Form
  $owner.TopMost = $true
  $owner.ShowInTaskbar = $false
  $owner.FormBorderStyle = 'None'
  $owner.Opacity = 0
  $owner.Size = New-Object System.Drawing.Size(1, 1)
  $owner.StartPosition = 'CenterScreen'
  $owner.Show()
  $owner.Activate()
  try {
    $f = New-Object System.Windows.Forms.OpenFileDialog
    $f.Multiselect = $false
    if ($f.ShowDialog($owner) -eq 'OK') { Write-Output $f.FileName }
    else { Write-Output '${CANCEL_SENTINEL}' }
  } finally {
    $owner.Close()
    $owner.Dispose()
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

// Runs a dialog command and collects its outcome without ever rejecting;
// callers decide what each outcome means on their platform.
function runDialog(spawnFn, bin, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawnFn(bin, args);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(outcome);
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        settle({ timedOut: true, stdout, stderr });
      }, timeoutMs);
    }
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => settle({ spawnError: err, stdout, stderr }));
    child.on('close', (code) => settle({ code, stdout, stderr }));
  });
}

function pathOrNull(stdout) {
  const trimmed = stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function pickWindows(spawnFn, timeoutMs) {
  const result = await runDialog(
    spawnFn,
    'powershell.exe',
    ['-NoProfile', '-STA', '-Command', PICKER_SCRIPT],
    timeoutMs
  );
  if (result.spawnError) throw result.spawnError;
  if (result.timedOut) {
    throw new Error('The file picker timed out — the dialog never came back.');
  }
  // Checked without regard to exit code: PowerShell reports non-terminating
  // errors on stderr while still exiting 0.
  if (result.stderr.trim()) throw new Error(result.stderr.trim());
  if (result.code !== 0) {
    throw new Error(`The file picker exited with code ${result.code}.`);
  }
  const picked = pathOrNull(result.stdout);
  if (picked === CANCEL_SENTINEL) return null;
  if (picked === null) {
    throw new Error('The file picker closed without returning a selection.');
  }
  return picked;
}

async function pickMac(spawnFn) {
  const result = await runDialog(spawnFn, 'osascript', ['-e', 'POSIX path of (choose file)']);
  if (result.spawnError) throw result.spawnError;
  if (result.code !== 0) {
    // Cancelling the dialog makes osascript exit non-zero with
    // "User canceled." on stderr — that's a cancel, not an error.
    if (/user cancell?ed/i.test(result.stderr)) return null;
    throw new Error(result.stderr.trim() || `osascript exited with code ${result.code}`);
  }
  return pathOrNull(result.stdout);
}

function linuxOutcome(result) {
  // zenity and kdialog both exit 1 when the user cancels.
  if (result.code === 1) return null;
  if (result.code !== 0 && result.stderr.trim()) {
    throw new Error(result.stderr.trim());
  }
  return pathOrNull(result.stdout);
}

async function pickLinux(spawnFn) {
  const zenity = await runDialog(spawnFn, 'zenity', ['--file-selection']);
  if (!zenity.spawnError) return linuxOutcome(zenity);
  if (zenity.spawnError.code !== 'ENOENT') throw zenity.spawnError;

  const kdialog = await runDialog(spawnFn, 'kdialog', ['--getopenfilename']);
  if (!kdialog.spawnError) return linuxOutcome(kdialog);
  if (kdialog.spawnError.code !== 'ENOENT') throw kdialog.spawnError;

  // Neither dialog tool is installed — no picker available.
  return null;
}

function pickFile({ spawnFn = spawn, platform = process.platform, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (platform === 'win32') return pickWindows(spawnFn, timeoutMs);
  if (platform === 'darwin') return pickMac(spawnFn);
  return pickLinux(spawnFn);
}

module.exports = { pickFile };
