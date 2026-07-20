// server/lib/mcpStatus.js
const { spawn } = require('child_process');

// `claude mcp list` prints a human-formatted report, not JSON:
//   Checking MCP server health…
//
//   claude.ai Spotify: https://mcp-gateway... - ✔ Connected
//   azure-devops: npx -y @azure-devops/mcp InTimeTec-ADO - ✔ Connected
// Each entry line is "<name>: <target> - <symbol> <statusText>". The header
// and blank lines have neither a ": " nor a " - " separator, so lines missing
// either are skipped rather than mis-parsed.
//
// The leading symbol is NOT a reliable signal on Windows: the same CLI prints
// "✔" (U+2714) under a UTF-8-capable shell (e.g. git-bash) but "√" (U+221A)
// for the identical "Connected" state under a native console (cmd/PowerShell)
// — it self-selects a glyph based on what the parent console can render.
// Classifying by the English statusText instead sidesteps that entirely.
function classifyStatusText(statusText) {
  const t = statusText.toLowerCase();
  if (t.includes('connected')) return 'connected';
  if (t.includes('auth')) return 'needs-auth';
  if (t.includes('pending')) return 'pending';
  if (t.includes('fail') || t.includes('error')) return 'error';
  return 'unknown';
}

function parseMcpListOutput(stdout) {
  const servers = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const dashIdx = line.lastIndexOf(' - ');
    const colonIdx = line.indexOf(': ');
    if (dashIdx === -1 || colonIdx === -1 || colonIdx > dashIdx) continue;

    const name = line.slice(0, colonIdx);
    const target = line.slice(colonIdx + 2, dashIdx);
    const statusPart = line.slice(dashIdx + 3);
    const spaceIdx = statusPart.indexOf(' ');
    const statusText = spaceIdx === -1 ? statusPart : statusPart.slice(spaceIdx + 1);

    servers.push({
      name,
      target,
      status: classifyStatusText(statusText),
      statusText,
    });
  }
  return servers;
}

function createMcpStatus({ spawnFn = spawn, claudeBin = 'claude' } = {}) {
  function listServers(cwd) {
    return new Promise((resolve, reject) => {
      const child = spawnFn(claudeBin, ['mcp', 'list'], { cwd });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });

      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(value);
      };

      child.on('error', (err) => finish(err));
      child.on('close', (code) => {
        if (code !== 0) {
          finish(new Error(`claude mcp list exited with code ${code}: ${stderr || stdout}`.trim()));
          return;
        }
        finish(null, { servers: parseMcpListOutput(stdout) });
      });
    });
  }

  return { listServers };
}

module.exports = { createMcpStatus, parseMcpListOutput };
