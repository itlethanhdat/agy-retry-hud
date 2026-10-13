// Async task framework (H2-1). Setup steps (H2-2) run on this: a task is a
// named sequence of steps executed one at a time. Tasks live in memory for
// the hub's lifetime (documented); they are never persisted to disk.
import crypto from 'node:crypto';

const registry = new Map(); // id -> task

/**
 * createTask(name, steps) => {id, name, status:'pending',
 *   steps:[{id,label,status:'pending',detail:''}], createdAt}.
 * Every step starts pending; runTask drives the transitions.
 */
export function createTask(name, steps) {
  const task = {
    id: crypto.randomUUID(),
    name,
    status: 'pending',
    steps: (steps || []).map(s => ({
      id: s.id,
      label: s.label ?? s.id,
      status: 'pending',
      detail: '',
    })),
    createdAt: Date.now(),
  };
  registry.set(task.id, task);
  return task;
}

/** getTask(id) => task | null. */
export function getTask(id) {
  return registry.get(id) ?? null;
}

/**
 * runTask(task, impls, onProgress, api) => task (never throws unless
 * onProgress throws).
 *
 * impls: {stepId: async (api) => ({detail?})}. Steps run sequentially;
 * each step transitions pending → running → ok | failed. The first failure
 * stops the run: remaining steps are marked skipped. A missing impl is a
 * failure, not a crash. onProgress(task) is called after every step
 * transition (running, ok, failed, skipped) so SSE consumers see progress.
 * onProgress runs outside the per-step try/catch, so a throwing onProgress
 * propagates (the hub's broadcast() guards its own writes).
 * `api` is passed to every impl (the hub passes {root}).
 */
export async function runTask(task, impls = {}, onProgress = () => {}, api = {}) {
  task.status = 'running';
  for (let i = 0; i < task.steps.length; i++) {
    const step = task.steps[i];
    step.status = 'running';
    onProgress(task);
    const impl = impls[step.id];
    try {
      if (typeof impl !== 'function') throw new Error(`no implementation for step '${step.id}'`);
      const r = await impl(api);
      step.status = 'ok';
      if (r && typeof r.detail === 'string') step.detail = r.detail;
    } catch (e) {
      step.status = 'failed';
      step.detail = String(e?.message || e);
      for (let j = i + 1; j < task.steps.length; j++) {
        task.steps[j].status = 'skipped';
        onProgress(task);
      }
      task.status = 'failed';
      onProgress(task);
      return task;
    }
    onProgress(task);
  }
  task.status = 'ok';
  onProgress(task);
  return task;
}
