// server/lib/folderPicker.js
//
// Cross-platform "pick a folder" dialog.
//   win32  -> PowerShell System.Windows.Forms.FolderBrowserDialog
//   darwin -> osascript `choose folder`
//   linux  -> zenity, falling back to kdialog, falling back to null
//
// Resolves the chosen absolute path, or null when the user cancels or no
// dialog tool is available. Rejects only on real failures.
const { spawn } = require('child_process');

const PICKER_SCRIPT = "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }";

// Runs a dialog command and collects its outcome without ever rejecting;
// callers decide what each outcome means on their platform.
function runDialog(spawnFn, bin, args) {
  return new Promise((resolve) => {
    const child = spawnFn(bin, args);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
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

async function pickWindows(spawnFn) {
  const result = await runDialog(spawnFn, 'powershell.exe', ['-NoProfile', '-STA', '-Command', PICKER_SCRIPT]);
  if (result.spawnError) throw result.spawnError;
  if (result.code !== 0 && result.stderr.trim()) {
    throw new Error(result.stderr.trim());
  }
  return pathOrNull(result.stdout);
}

async function pickMac(spawnFn) {
  const result = await runDialog(spawnFn, 'osascript', ['-e', 'POSIX path of (choose folder)']);
  if (result.spawnError) throw result.spawnError;
  if (result.code !== 0) {
    // Cancelling the dialog makes osascript exit non-zero with
    // "User canceled." on stderr — that's a cancel, not an error.
    if (/user cancell?ed/i.test(result.stderr)) return null;
    throw new Error(result.stderr.trim() || `osascript exited with code ${result.code}`);
  }
  const picked = pathOrNull(result.stdout);
  if (picked === null) return null;
  // `POSIX path of` returns a trailing slash; strip it (but keep bare "/").
  const stripped = picked.replace(/\/+$/, '');
  return stripped.length > 0 ? stripped : '/';
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
  const zenity = await runDialog(spawnFn, 'zenity', ['--file-selection', '--directory']);
  if (!zenity.spawnError) return linuxOutcome(zenity);
  if (zenity.spawnError.code !== 'ENOENT') throw zenity.spawnError;

  const kdialog = await runDialog(spawnFn, 'kdialog', ['--getexistingdirectory']);
  if (!kdialog.spawnError) return linuxOutcome(kdialog);
  if (kdialog.spawnError.code !== 'ENOENT') throw kdialog.spawnError;

  // Neither dialog tool is installed — no picker available.
  return null;
}

function pickFolder({ spawnFn = spawn, platform = process.platform } = {}) {
  if (platform === 'win32') return pickWindows(spawnFn);
  if (platform === 'darwin') return pickMac(spawnFn);
  return pickLinux(spawnFn);
}

module.exports = { pickFolder };
