// Handoff snapshots for account rotation. By design the builder takes no
// token field: handoffs may contain code and conversation summaries but
// never credential material.
import fs from 'node:fs';
import path from 'node:path';

export const HANDOFF_SCHEMA_VERSION = 1;

/**
 * buildHandoff({sessionId, fromAccount, cwd, gitHead, gitDirty,
 *   summary, pendingTodos, interruptedTool, now}) => object
 */
export function buildHandoff(o = {}) {
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    sessionId: o.sessionId || '',
    fromAccount: o.fromAccount || '',
    cwd: o.cwd || '',
    gitHead: o.gitHead || '',
    gitDirty: Array.isArray(o.gitDirty) ? o.gitDirty : [],
    summary: o.summary || '',
    pendingTodos: Array.isArray(o.pendingTodos) ? o.pendingTodos : [],
    interruptedTool: o.interruptedTool || null,
    resumeMode: null, // set by rotateOnce: 'native' | 'handoff-inject'
    createdAt: Number.isFinite(o.now) ? o.now : Date.now(),
  };
}

/** writeHandoff(dir, handoff) => filepath — atomic write, mode 0600. */
export function writeHandoff(dir, handoff) {
  fs.mkdirSync(dir, { recursive: true });
  const name = `${handoff.sessionId || 'session'}-${handoff.createdAt}.json`;
  const file = path.join(dir, name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(handoff, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/**
 * summarizeTranscript(lines: string[]) => string — last 200 lines of session
 * output, capped at 4000 chars. Feeds the handoff `summary` so a fallback
 * resume still carries work context.
 */
export function summarizeTranscript(lines = []) {
  return lines.slice(-200).join('\n').slice(-4000);
}
