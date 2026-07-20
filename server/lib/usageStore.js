// server/lib/usageStore.js
//
// Tracks cumulative cost/token usage reported by the `claude` CLI's
// --output-format json responses. This is NOT an account-level quota or
// rate-limit meter — the CLI exposes no such thing (see CLAUDE.md /
// docs/ROADMAP.md). It is purely a running total of the per-invocation
// `total_cost_usd` / `usage` figures the CLI already returns from every
// startSession/sendMessage call, persisted across restarts.
const { readJson, writeJson } = require('./jsonStore');

function emptyTotals() {
  return { costUsd: 0, inputTokens: 0, outputTokens: 0, callCount: 0 };
}

// Coerces a possibly-missing/malformed field to a finite number, defaulting
// to 0. Claude CLI error responses can omit `usage`/`total_cost_usd`
// entirely, and we must never throw on that.
function toNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function createUsageStore({ filePath }) {
  function readState() {
    const data = readJson(filePath, null);
    if (!data || typeof data !== 'object') {
      return { allTime: emptyTotals(), sessions: {} };
    }
    return {
      allTime: { ...emptyTotals(), ...(data.allTime || {}) },
      sessions: { ...(data.sessions || {}) },
    };
  }

  // Adds one call's cost/token figures onto the running totals for
  // `sessionId` and onto the all-time total, then persists. Missing/
  // malformed fields default to 0 rather than throwing or poisoning the
  // accumulated totals with NaN.
  function recordUsage(sessionId, { costUsd, inputTokens, outputTokens } = {}) {
    if (!sessionId) return null;
    const state = readState();
    const cost = toNumber(costUsd);
    const input = toNumber(inputTokens);
    const output = toNumber(outputTokens);

    const existing = state.sessions[sessionId] || emptyTotals();
    const updatedSession = {
      costUsd: existing.costUsd + cost,
      inputTokens: existing.inputTokens + input,
      outputTokens: existing.outputTokens + output,
      callCount: existing.callCount + 1,
    };
    state.sessions[sessionId] = updatedSession;
    state.allTime = {
      costUsd: state.allTime.costUsd + cost,
      inputTokens: state.allTime.inputTokens + input,
      outputTokens: state.allTime.outputTokens + output,
      callCount: state.allTime.callCount + 1,
    };

    writeJson(filePath, state);
    return updatedSession;
  }

  function getAll() {
    return readState();
  }

  function getSession(sessionId) {
    return readState().sessions[sessionId] || emptyTotals();
  }

  return { recordUsage, getAll, getSession };
}

module.exports = { createUsageStore };
