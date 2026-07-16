// server/lib/folderPicker.js
const { spawn } = require('child_process');

const PICKER_SCRIPT = "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }";

function pickFolder({ spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn('powershell.exe', ['-NoProfile', '-STA', '-Command', PICKER_SCRIPT]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && stderr.trim()) {
        reject(new Error(stderr.trim()));
        return;
      }
      const trimmed = stdout.trim();
      resolve(trimmed.length > 0 ? trimmed : null);
    });
  });
}

module.exports = { pickFolder };
