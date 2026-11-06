import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __clearJobs, getJob, listJobs, registerJob } from './registry';
import { runJobWithMonitoring, type RunRecorder } from './runner';
import { MemoryScheduler } from './memory';

function memRecorder() {
  const runs: { id: string; name: string; status: string; summary?: string; error?: string }[] = [];
  let n = 0;
  const recorder: RunRecorder = {
    start: async (name) => {
      const id = `run-${++n}`;
      runs.push({ id, name, status: 'running' });
      return id;
    },
    finish: async (id, status, summary, error) => {
      const run = runs.find((r) => r.id === id);
      assert.ok(run);
      run.status = status;
      run.summary = summary;
      run.error = error;
    },
  };
  return { recorder, runs };
}

describe('jobs registry', () => {
  it('rejects duplicates, unknown lookups, and non-cron schedules', () => {
    __clearJobs();
    registerJob({ name: 'a', description: 'a', cron: '* * * * *', run: async () => ({ ok: true }) });
    assert.throws(() => registerJob({ name: 'a', description: 'dup', cron: '* * * * *', run: async () => ({ ok: true }) }), /already registered/);
    assert.throws(() => getJob('nope'), /Unknown job/);
    assert.throws(
      () => registerJob({ name: 'bad', description: 'bad', cron: 'every minute', run: async () => ({ ok: true }) }),
      /5-field/,
    );
    assert.deepEqual(listJobs().map((j) => j.name), ['a']);
    __clearJobs();
  });
});

describe('jobs runner', () => {
  it('records ok runs and catches throws without crashing', async () => {
    __clearJobs();
    const { recorder, runs } = memRecorder();
    registerJob({ name: 'good', description: 'good', cron: '* * * * *', run: async () => ({ ok: true, summary: 'did it' }) });
    registerJob({
      name: 'bad',
      description: 'bad',
      cron: '* * * * *',
      run: async () => {
        throw new Error('boom');
      },
    });
    const ok = await runJobWithMonitoring('good', 'manual', recorder, () => {});
    assert.equal(ok.ok, true);
    const failed = await runJobWithMonitoring('bad', 'manual', recorder, () => {});
    assert.equal(failed.ok, false);
    assert.deepEqual(
      runs.map((r) => [r.name, r.status]),
      [
        ['good', 'ok'],
        ['bad', 'failed'],
      ],
    );
    assert.equal(runs[1].error, 'boom');
    __clearJobs();
  });
});

describe('memory scheduler', () => {
  it('trigger runs immediately and cron fires on schedule', { timeout: 15000 }, async () => {
    __clearJobs();
    const { recorder, runs } = memRecorder();
    let fires = 0;
    registerJob({
      name: 'tick',
      description: 'tick',
      cron: '* * * * *',
      run: async () => {
        fires += 1;
        return { ok: true };
      },
    });
    const sched = new MemoryScheduler(recorder);
    const out = await sched.trigger('tick');
    assert.equal(out.ok, true);
    assert.equal(fires, 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'ok');

    // Second scheduler with a per-second schedule proves the cron loop fires by itself.
    __clearJobs();
    let autoFires = 0;
    registerJob({
      name: 'auto',
      description: 'auto',
      cron: '*/1 * * * * *',
      run: async () => {
        autoFires += 1;
        return { ok: true };
      },
    });
    const sched2 = new MemoryScheduler(recorder);
    const stop = await sched2.start();
    await new Promise((r) => setTimeout(r, 2500));
    await stop();
    assert.ok(autoFires >= 1, `expected >=1 auto fire, got ${autoFires}`);
    await sched.close();
    __clearJobs();
  });
});
