// public/format.js
function formatRelativeTime(isoString, now = new Date()) {
  const then = new Date(isoString);
  const diffMs = now.getTime() - then.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d`;
}

// Formats a USD amount for the usage displays. Per-call costs from the
// claude CLI are frequently fractions of a cent, so amounts under a cent
// get extra decimal places rather than rounding down to "$0.00".
function formatCurrency(amount) {
  const n = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
  if (n === 0) return '$0.00';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatRelativeTime, formatCurrency };
}
