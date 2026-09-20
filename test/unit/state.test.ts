import { describe, it, expect } from 'vitest';
import { unlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { newManifest, readJson } from '../../src/pack/io';
import { PackPaths, RunPaths } from '../../src/pack/paths';
import { LockFileSchema, type Manifest, type UnitRecord } from '../../src/pack/schemas';
import { ERROR_CODES } from '../../src/pack/defaults';
import {
  IllegalTransition,
  dependentsOf,
  nextUnits,
  openQuestions,
  restore,
  scopeOf,
  scopesOf,
  summary,
  transition,
} from '../../src/orchestrate/state';
import { freeRunName, runName } from '../../src/orchestrate/build';
import { acquireLock, LockError, processAlive } from '../../src/orchestrate/lock';
import { planText } from '../../src/orchestrate/plan';
import { reportText } from '../../src/orchestrate/report';

const AT = '2026-09-18T00:00:00.000Z';

function manifestWith(
  units: Record<string, Partial<UnitRecord> & { kind: UnitRecord['kind'] }>,
): Manifest {
  const m = newManifest({ host: 'x.com', sourceUrl: 'https://x.com/' });
  for (const [id, u] of Object.entries(units)) {
    m.units[id] = { status: 'captured', dependsOn: [], rounds: 0, updatedAt: AT, ...u };
  }
  return m;
}

/** two pages with sections, a state on the first, and a two-step flow, all captured */
function site(): Manifest {
  return manifestWith({
    'page:index#s01-header': { kind: 'section' },
    'page:index#s02-hero': { kind: 'section' },
    'page:index': {
      kind: 'page',
      url: 'https://x.com/',
      dependsOn: ['page:index#s01-header', 'page:index#s02-hero'],
    },
    'state:index/menu-open': { kind: 'state', url: 'https://x.com/', dependsOn: ['page:index'] },
    'page:about#s01-header': { kind: 'section' },
    'page:about': {
      kind: 'page',
      url: 'https://x.com/about',
      dependsOn: ['page:about#s01-header'],
    },
    'flow:signup/step-01-click-go': { kind: 'flowStep', url: 'https://x.com/' },
    'flow:signup/step-02-input-email': {
      kind: 'flowStep',
      url: 'https://x.com/',
      dependsOn: ['flow:signup/step-01-click-go'],
    },
  });
}

describe('nextUnits', () => {
  it('returns nothing for an empty manifest or one with nothing captured', () => {
    expect(
      nextUnits(newManifest({ host: 'x.com', sourceUrl: 'https://x.com/' }), { parallel: 2 }),
    ).toEqual([]);
    const planned = manifestWith({ 'page:index': { kind: 'page', status: 'planned' } });
    expect(nextUnits(planned, { parallel: 2 })).toEqual([]);
  });

  it('picks ready units in dependency order, one per page, up to the parallel count', () => {
    const m = site();
    // sections come first, sorted by id; the page waits for its sections, the state for its page
    expect(nextUnits(m, { parallel: 2 })).toEqual(['page:about#s01-header', 'page:index#s02-hero']);
    expect(nextUnits(m, { parallel: 4 })).toEqual([
      'page:about#s01-header',
      'page:index#s02-hero',
      'flow:signup/step-01-click-go',
    ]);
    expect(nextUnits(m, { parallel: 1 })).toEqual(['page:about#s01-header']);
  });

  it('holds a unit back when any of its scopes is in flight, its page or the shared chrome', () => {
    // a unit is a set of scopes, not one: its page always, and `chrome` as well for a header,
    // a nav or a footer, because every page's is built from one shared layout
    const twoPages = () =>
      manifestWith({
        'page:index#s01-header': { kind: 'section' },
        'page:index#s02-hero': { kind: 'section' },
        'page:about#s01-header': { kind: 'section' },
        'page:about#s02-hero': { kind: 'section' },
      });
    expect(scopesOf(twoPages(), 'page:index#s02-hero')).toEqual(['page:index']);
    expect(scopesOf(twoPages(), 'page:index#s01-header')).toEqual(['page:index', 'chrome']);

    // the no-op negative, and the invariant that was there first: two ordinary sections of one
    // page share its feature dir and its route, so one page never has two workers
    const onePage = manifestWith({
      'page:index#s02-hero': { kind: 'section' },
      'page:index#s03-features': { kind: 'section' },
    });
    expect(nextUnits(onePage, { parallel: 2 })).toEqual(['page:index#s02-hero']);

    // two pages' headers are one layout, so they are one scope and one of them goes
    const headers = manifestWith({
      'page:index#s01-header': { kind: 'section' },
      'page:about#s01-header': { kind: 'section' },
    });
    expect(nextUnits(headers, { parallel: 2 })).toEqual(['page:about#s01-header']);

    // a header in flight holds back both: its own page's hero on the page scope, and the other
    // page's header on the chrome scope. a page the header has nothing to do with still goes
    const m = twoPages();
    transition(m, 'page:index#s01-header', { type: 'build_started' }, AT);
    expect(nextUnits(m, { parallel: 9 })).toEqual(['page:about#s02-hero']);
  });

  it('never returns two sections of one page, and counts an in-flight page against the slots', () => {
    const m = site();
    transition(m, 'page:index#s02-hero', { type: 'build_started' }, AT);
    expect(nextUnits(m, { parallel: 2 })).toEqual(['page:about#s01-header']);
    expect(nextUnits(m, { parallel: 1 })).toEqual([]);
    for (const id of ['page:index#s02-hero']) {
      transition(m, id, { type: 'verify_started' }, AT);
      transition(m, id, { type: 'verify_passed', score: 0 }, AT);
      transition(m, id, { type: 'review_passed' }, AT);
    }
    expect(nextUnits(m, { parallel: 3 })).toEqual([
      'page:about#s01-header',
      'flow:signup/step-01-click-go',
    ]);
  });

  it('makes a page ready only once every section passed, and a state once its page did', () => {
    const m = site();
    for (const id of ['page:index#s01-header', 'page:index#s02-hero']) {
      transition(m, id, { type: 'build_started' }, AT);
      transition(m, id, { type: 'verify_started' }, AT);
      transition(m, id, { type: 'verify_passed', score: 0 }, AT);
      transition(m, id, { type: 'review_passed' }, AT);
    }
    expect(nextUnits(m, { parallel: 9 })).toEqual([
      'page:about#s01-header',
      'page:index',
      'flow:signup/step-01-click-go',
    ]);
    expect(scopeOf('page:index#s02-hero')).toBe('page:index');
    expect(scopeOf('state:index/menu-open')).toBe('page:index');
    expect(scopeOf('flow:signup/step-01-click-go')).toBe('flow:signup');
    // the page scope of a chrome section is still its page; `chrome` is the second one
    expect(scopeOf('page:index#s01-header')).toBe('page:index');
  });
});

describe('transition', () => {
  it('walks a unit through a passing round and counts the round once', () => {
    const m = site();
    const id = 'page:index#s02-hero';
    expect(transition(m, id, { type: 'build_started' }, AT)).toMatchObject({
      status: 'building',
      rounds: 1,
    });
    expect(transition(m, id, { type: 'rate_limited' }, AT)).toMatchObject({
      status: 'building',
      rounds: 1,
    });
    expect(transition(m, id, { type: 'verify_started' }, AT).status).toBe('verifying');
    expect(transition(m, id, { type: 'verify_passed', score: 0.0004 }, AT)).toMatchObject({
      status: 'reviewing',
      lastScore: 0.0004,
    });
    expect(transition(m, id, { type: 'review_passed' }, AT).status).toBe('passed');
    expect(m.units[id]!.updatedAt).toBe(AT);
  });

  it('sends a failed verify, a rejected review and a failed build back to captured', () => {
    const m = site();
    const id = 'page:index#s02-hero';
    transition(m, id, { type: 'build_started' }, AT);
    transition(m, id, { type: 'verify_started' }, AT);
    expect(transition(m, id, { type: 'verify_failed', score: 0.2 }, AT)).toMatchObject({
      status: 'captured',
      rounds: 1,
      lastScore: 0.2,
    });
    transition(m, id, { type: 'build_started' }, AT);
    transition(m, id, { type: 'verify_started' }, AT);
    transition(m, id, { type: 'verify_passed', score: 0 }, AT);
    expect(transition(m, id, { type: 'review_rejected' }, AT)).toMatchObject({
      status: 'captured',
      rounds: 2,
    });
    transition(m, id, { type: 'build_started' }, AT);
    expect(transition(m, id, { type: 'build_failed', reason: 'crashed' }, AT)).toMatchObject({
      status: 'captured',
      rounds: 3,
    });
  });

  it('refuses an illegal event with the unit, its status and the event named', () => {
    const m = site();
    expect(() =>
      transition(m, 'page:index#s02-hero', { type: 'verify_passed', score: 0 }, AT),
    ).toThrow(IllegalTransition);
    expect(() => transition(m, 'page:index#s02-hero', { type: 'review_passed' }, AT)).toThrow(
      /page:index#s02-hero: review_passed is not legal from captured/,
    );
    expect(() => transition(m, 'page:nope', { type: 'build_started' }, AT)).toThrow(
      /not in the manifest/,
    );
    // nothing changed
    expect(m.units['page:index#s02-hero']).toMatchObject({ status: 'captured', rounds: 0 });
  });

  it('blocks with the artefacts and a question, and reopens with a clean slate', () => {
    const m = site();
    const id = 'page:index#s02-hero';
    transition(m, id, { type: 'build_started' }, AT);
    transition(m, id, { type: 'verify_started' }, AT);
    transition(m, id, { type: 'verify_failed', score: 0.3 }, AT);
    const blocked = transition(
      m,
      id,
      {
        type: 'blocked',
        code: ERROR_CODES.roundsExhausted,
        message: '1 round without a pass: pixel 30.000%',
        artefacts: ['/p/runs/r/x/round-1/verify/verify.json'],
      },
      AT,
    );
    expect(blocked).toMatchObject({
      status: 'blocked',
      blockedReason: 'rounds_exhausted',
      artefacts: ['/p/runs/r/x/round-1/verify/verify.json'],
    });
    expect(blocked.question).toContain('1 round without a pass: pixel 30.000%');
    expect(openQuestions(m).map((q) => q.unit)).toEqual([id]);
    const reopened = transition(m, id, { type: 'reopened' }, AT);
    expect(reopened).toMatchObject({ status: 'captured', rounds: 0 });
    expect(reopened.blockedReason).toBeUndefined();
    expect(reopened.question).toBeUndefined();
    expect(reopened.artefacts).toBeUndefined();
    expect(openQuestions(m)).toEqual([]);
    expect(m.questions[0]).toMatchObject({ unit: id, answer: 'reopened', answeredAt: AT });
  });

  it('reopens a capture-side block to planned and every other block to captured', () => {
    // the no-op negative: a block the orchestrator raised has a capture on disk, so the unit
    // goes back to the queue the builder works
    const m = site();
    const orchestrated = 'page:index#s02-hero';
    transition(
      m,
      orchestrated,
      { type: 'blocked', code: ERROR_CODES.roundsExhausted, message: '6 rounds' },
      AT,
    );
    expect(transition(m, orchestrated, { type: 'reopened' }, AT).status).toBe('captured');
    transition(
      m,
      orchestrated,
      { type: 'blocked', code: ERROR_CODES.dependency, message: 'its section blocked' },
      AT,
    );
    expect(transition(m, orchestrated, { type: 'reopened' }, AT).status).toBe('captured');
    // a unit capture blocked has no unit files at all: reopening it as captured would send the
    // next builder brief looking for them and take the whole run down the bug path
    for (const code of [
      ERROR_CODES.blockedBySite,
      ERROR_CODES.unreachable,
      ERROR_CODES.navigationFailed,
      ERROR_CODES.httpError,
      ERROR_CODES.fontsMissing,
      ERROR_CODES.needsInput,
    ]) {
      const id = 'page:about#s01-header';
      transition(m, id, { type: 'blocked', code, message: `${code} at capture` }, AT);
      expect(transition(m, id, { type: 'reopened' }, AT), code).toMatchObject({
        status: 'planned',
        rounds: 0,
      });
      // a planned unit is the capture's to work, not the builder's: it is not offered
      expect(nextUnits(m, { parallel: 9 }), code).not.toContain(id);
      m.units[id]!.status = 'captured';
    }
  });

  it('sends a crashed reviewer back to captured without spending another round', () => {
    const m = site();
    const id = 'page:index#s02-hero';
    transition(m, id, { type: 'build_started' }, AT);
    transition(m, id, { type: 'verify_started' }, AT);
    transition(m, id, { type: 'verify_passed', score: 0 }, AT);
    // the reviewer process failed, so the round failed; it is not a reject and not a pass
    expect(transition(m, id, { type: 'review_failed', reason: 'crashed' }, AT)).toMatchObject({
      status: 'captured',
      rounds: 1,
    });
    expect(() => transition(m, id, { type: 'review_failed', reason: 'crashed' }, AT)).toThrow(
      IllegalTransition,
    );
  });

  it('clears the last score when a round had nothing to compare', () => {
    const m = site();
    const id = 'page:index#s02-hero';
    transition(m, id, { type: 'build_started' }, AT);
    transition(m, id, { type: 'verify_started' }, AT);
    expect(transition(m, id, { type: 'verify_failed', score: 0.2 }, AT).lastScore).toBe(0.2);
    transition(m, id, { type: 'build_started' }, AT);
    transition(m, id, { type: 'verify_started' }, AT);
    expect(transition(m, id, { type: 'verify_failed', score: null }, AT).lastScore).toBeUndefined();
  });

  it('blocks an already blocked unit and keeps one open question, the latest', () => {
    const m = site();
    const id = 'page:index';
    transition(
      m,
      id,
      { type: 'blocked', code: ERROR_CODES.dependency, message: 'its section blocked' },
      AT,
    );
    // a cascade reaches a unit twice in one run: the second block updates, it does not throw
    const again = transition(
      m,
      id,
      { type: 'blocked', code: ERROR_CODES.roundsExhausted, message: '6 rounds without a pass' },
      AT,
    );
    expect(again).toMatchObject({ status: 'blocked', blockedReason: 'rounds_exhausted' });
    expect(again.question).toContain('6 rounds without a pass');
    const mine = m.questions.filter((q) => q.unit === id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toBe(again.question);
    expect(openQuestions(m)).toHaveLength(1);
  });

  it('puts an interrupted unit back without spending the round', () => {
    const m = site();
    const id = 'page:index#s02-hero';
    transition(m, id, { type: 'build_started' }, AT);
    expect(transition(m, id, { type: 'interrupted' }, AT)).toMatchObject({
      status: 'captured',
      rounds: 0,
    });
    expect(() => transition(m, id, { type: 'interrupted' }, AT)).toThrow(IllegalTransition);
  });
});

describe('restore, dependents, questions, summary', () => {
  it('restores every in-flight unit and names them', () => {
    const m = site();
    transition(m, 'page:index#s01-header', { type: 'build_started' }, AT);
    transition(m, 'page:about#s01-header', { type: 'build_started' }, AT);
    transition(m, 'page:about#s01-header', { type: 'verify_started' }, AT);
    expect(restore(m, AT)).toEqual(['page:about#s01-header', 'page:index#s01-header']);
    expect(restore(m, AT)).toEqual([]);
    expect(m.units['page:about#s01-header']).toMatchObject({ status: 'captured', rounds: 0 });
  });

  it('lists the transitive dependents of a unit', () => {
    expect(dependentsOf(site(), 'page:index#s02-hero')).toEqual([
      'page:index',
      'state:index/menu-open',
    ]);
    expect(dependentsOf(site(), 'state:index/menu-open')).toEqual([]);
  });

  it('treats a recorded input question as answered once the input is set', () => {
    const m = site();
    m.flows['signup'] = { steps: [], inputs: { email: null } };
    m.questions.push({ id: 'flow:signup:input:email', text: 'needs email' });
    m.questions.push({ id: 'q-1', text: 'a wall', answer: 'skip', answeredAt: AT });
    expect(openQuestions(m).map((q) => q.id)).toEqual(['flow:signup:input:email']);
    m.flows['signup']!.inputs['email'] = 'ada@example.com';
    expect(openQuestions(m)).toEqual([]);
  });

  it('summarises counts, readiness, flows and questions', () => {
    const m = site();
    m.flows['signup'] = {
      steps: ['flow:signup/step-01-click-go'],
      inputs: { email: 'ada@example.com' },
    };
    transition(m, 'page:about#s01-header', { type: 'build_started' }, AT);
    transition(m, 'page:index#s01-header', { type: 'blocked', code: 'x', message: 'broke' }, AT);
    const s = summary(m);
    expect(s.total).toBe(8);
    expect(s.byStatus).toEqual({
      planned: 0,
      captured: 6,
      building: 1,
      verifying: 0,
      reviewing: 0,
      passed: 0,
      blocked: 1,
    });
    expect(s.byKind).toEqual({ page: 2, section: 3, state: 1, flowStep: 2 });
    expect(s.ready).toEqual(['page:index#s02-hero', 'flow:signup/step-01-click-go']);
    expect(s.inFlight).toEqual(['page:about#s01-header']);
    expect(s.blocked).toEqual([
      {
        id: 'page:index#s01-header',
        reason: 'x',
        question: m.units['page:index#s01-header']!.question,
      },
    ]);
    expect(s.flows).toEqual([{ name: 'signup', steps: 1, inputs: { email: 'ada@example.com' } }]);
    expect(s.questions.open).toHaveLength(1);
    expect(s.questions.answered).toBe(0);
  });
});

describe('lock', () => {
  const DEAD = { pid: 999_999, run: 'dead', startedAt: AT };

  /** a temp pack root, its lock file, its reclaim mutex, and the cleanup the caller runs */
  async function packRoot(): Promise<{
    root: string;
    file: string;
    reclaim: string;
    clean: () => Promise<void>;
  }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'site-lock-'));
    const file = new PackPaths(root).lock;
    await fs.mkdir(path.dirname(file), { recursive: true });
    return {
      root,
      file,
      reclaim: `${file}.reclaim`,
      clean: () => fs.rm(root, { recursive: true, force: true }),
    };
  }

  it('reads this process as alive and a pid nobody has as gone', () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(999_999)).toBe(false);
  });

  it('takes a free lock without reclaiming anything', async () => {
    const { root, file, clean } = await packRoot();
    try {
      const release = await acquireLock(root, 'r1');
      // nothing was there to judge, so the reclaim mutex never appears
      expect(await fs.readdir(path.dirname(file))).toEqual(['.lock']);
      await release();
      expect(await fs.readdir(path.dirname(file))).toEqual([]);
    } finally {
      await clean();
    }
  });

  it('lets one holder in, refuses a second, and reclaims a dead holder', async () => {
    const { root, file, clean } = await packRoot();
    try {
      const release = await acquireLock(root, 'r1');
      expect(await readJson(LockFileSchema, file)).toMatchObject({ pid: process.pid, run: 'r1' });
      await expect(acquireLock(root, 'r2')).rejects.toThrow(LockError);
      await expect(acquireLock(root, 'r2')).rejects.toThrow(/pid \d+, run r1/);
      await expect(acquireLock(root, 'r2')).rejects.toThrow(new RegExp(`delete ${file}`));
      await release();
      await expect(fs.stat(file)).rejects.toThrow();
      // a holder whose process is gone is a leftover of a killed build, not a live build
      await fs.writeFile(file, JSON.stringify(DEAD));
      const again = await acquireLock(root, 'r3', { alive: () => false });
      expect((await readJson(LockFileSchema, file)).run).toBe('r3');
      // the reclaim mutex is released on the way out, so it is not there afterwards
      expect(await fs.readdir(path.dirname(file))).toEqual(['.lock']);
      await again();
    } finally {
      await clean();
    }
  });

  it('reclaims a lock file that no longer reads as one', async () => {
    const { root, file, clean } = await packRoot();
    try {
      // a half-written or hand-edited lock names nobody, so nobody is holding the pack
      await fs.writeFile(file, '{');
      const release = await acquireLock(root, 'r1');
      expect((await readJson(LockFileSchema, file)).run).toBe('r1');
      await release();
    } finally {
      await clean();
    }
  });

  it('takes the lock on the next attempt when the file goes away under it', async () => {
    const { root, file, clean } = await packRoot();
    try {
      await fs.writeFile(file, JSON.stringify(DEAD));
      // stands in for the starter that reclaimed the same dead holder first: it is already gone
      const release = await acquireLock(root, 'r1', {
        alive: () => {
          unlinkSync(file);
          return false;
        },
      });
      expect((await readJson(LockFileSchema, file)).run).toBe('r1');
      await release();
    } finally {
      await clean();
    }
  });

  it('never deletes a lock whose record changed while it was being judged', async () => {
    const { root, file, reclaim, clean } = await packRoot();
    try {
      await fs.writeFile(file, JSON.stringify(DEAD));
      const live = { pid: process.pid, run: 'won-the-race', startedAt: AT };
      // the starter that judged this record dead is slow; by the time it reclaims, the starter
      // that got there first has taken the lock and written its own live record
      let raced = false;
      const alive = (pid: number) => {
        if (pid !== DEAD.pid) return true;
        if (!raced) {
          raced = true;
          writeFileSync(file, JSON.stringify(live));
        }
        return false;
      };
      await expect(acquireLock(root, 'r1', { alive })).rejects.toThrow(/run won-the-race/);
      // the live record is untouched: the conditional delete refused to take someone else's lock
      expect(await readJson(LockFileSchema, file)).toEqual(live);
      expect(await fs.readdir(path.dirname(file))).toEqual(['.lock']);
      await expect(fs.stat(reclaim)).rejects.toThrow();
    } finally {
      await clean();
    }
  });

  it('gives a run a dir of its own when one of the same name is already there', async () => {
    const { root, clean } = await packRoot();
    try {
      const base = runName(new Date('2026-09-18T10:00:00.000Z'));
      expect(base).toBe('2026-09-18T10-00-00');
      // the no-op negative: nothing is there, so the run keeps the name the clock gave it
      expect(await freeRunName(root, base)).toBe(base);
      await expect(fs.stat(new RunPaths(root, base).dir)).resolves.toBeTruthy();
      // runName has second resolution: a second run started inside the same second would
      // otherwise write its run.json over the first's and work into its round dirs
      expect(await freeRunName(root, base)).toBe(`${base}-2`);
      expect(await freeRunName(root, base)).toBe(`${base}-3`);
      await expect(fs.stat(new RunPaths(root, `${base}-3`).dir)).resolves.toBeTruthy();
    } finally {
      await clean();
    }
  });

  it('removes a reclaim mutex a killed starter left behind', async () => {
    const { root, file, reclaim, clean } = await packRoot();
    try {
      await fs.writeFile(file, JSON.stringify(DEAD));
      await fs.mkdir(reclaim);
      const minuteAgo = new Date(Date.now() - 60_000);
      await fs.utimes(reclaim, minuteAgo, minuteAgo);
      const release = await acquireLock(root, 'r1', { alive: () => false });
      expect((await readJson(LockFileSchema, file)).run).toBe('r1');
      await expect(fs.stat(reclaim)).rejects.toThrow();
      await release();
    } finally {
      await clean();
    }
  });

  it('waits out a live reclaim mutex and gives up rather than reclaiming behind it', async () => {
    const { root, file, reclaim, clean } = await packRoot();
    try {
      await fs.writeFile(file, JSON.stringify(DEAD));
      // another starter is inside the reclaim right now, so this one never gets to judge
      await fs.mkdir(reclaim);
      await expect(
        acquireLock(root, 'r1', { alive: () => false, attempts: 2, delayMs: 1 }),
      ).rejects.toThrow(/could not take the lock in 2 attempts; it kept changing under us/);
      expect(await readJson(LockFileSchema, file)).toEqual(DEAD);
      await expect(fs.stat(reclaim)).resolves.toBeTruthy();
    } finally {
      await clean();
    }
  });

  it('gives up, naming the file, when the lock never becomes takeable', async () => {
    const { root, file, clean } = await packRoot();
    try {
      // a lock pointing at nothing: an exclusive create says it is there, reading it says it is not
      await fs.symlink(path.join(path.dirname(file), 'gone.json'), file);
      await expect(acquireLock(root, 'r1')).rejects.toThrow(
        /could not take the lock in 5 attempts/,
      );
      await expect(acquireLock(root, 'r1')).rejects.toThrow(new RegExp(`^${file}: `));
    } finally {
      await clean();
    }
  });
});

describe('planText and reportText', () => {
  it('prints the queue, the flows with their inputs and the open questions', () => {
    const m = site();
    m.flows['signup'] = { steps: ['flow:signup/step-01-click-go'], inputs: { email: null } };
    m.questions.push({ id: 'flow:signup:input:email', text: 'needs email' });
    transition(m, 'page:index#s01-header', { type: 'blocked', code: 'x', message: 'broke' }, AT);
    const text = planText(m);
    expect(text).toContain('8 units');
    expect(text).toContain('captured 7');
    expect(text).toContain('blocked 1');
    expect(text).toContain('ready now: 3');
    expect(text).toContain('signup: 1 step, inputs: email (unset)');
    expect(text).toContain('[flow:signup:input:email] needs email');
    expect(text).toContain('[q-page_index_s01-header-1] page:index#s01-header: broke');
    expect(text).toContain('2 open questions');
    expect(text).toContain('site build refuses to start');
  });

  it('writes the report from the manifest and the run log', () => {
    const m = site();
    transition(m, 'page:about#s01-header', { type: 'build_started' }, AT);
    transition(m, 'page:about#s01-header', { type: 'verify_started' }, AT);
    transition(m, 'page:about#s01-header', { type: 'verify_passed', score: 0 }, AT);
    transition(m, 'page:about#s01-header', { type: 'review_passed' }, AT);
    transition(
      m,
      'page:index#s01-header',
      {
        type: 'blocked',
        code: 'rounds_exhausted',
        message: '2 rounds without a pass: verify failed',
        artefacts: ['/p/runs/r1/x/round-2/verify/verify.json'],
      },
      AT,
    );
    const text = reportText(m, {
      run: 'r1',
      root: '/p',
      project: '/b',
      target: 'http://127.0.0.1:3000',
      claude: 'claude',
      options: { parallel: 2, rounds: 2, threshold: null },
      startedAt: '2026-09-18T10:00:00.000Z',
      endedAt: '2026-09-18T10:12:30.000Z',
      restored: ['page:index#s02-hero'],
      rounds: [
        {
          unitId: 'page:about#s01-header',
          round: 1,
          dir: 'runs/r1/a/round-1',
          startedAt: AT,
          endedAt: AT,
          builder: null,
          checks: [],
          verify: { verdict: 'pass', score: 0, file: 'runs/r1/a/round-1/verify/verify.json' },
          reviewer: null,
          waits: [{ at: AT, ms: 60000, why: 'api 429' }],
          result: 'passed',
          reason: null,
        },
        {
          unitId: 'page:index#s01-header',
          round: 2,
          dir: 'runs/r1/x/round-2',
          startedAt: AT,
          endedAt: AT,
          builder: null,
          checks: [],
          verify: { verdict: 'fail', score: 0.3, file: 'runs/r1/x/round-2/verify/verify.json' },
          reviewer: null,
          waits: [],
          result: 'blocked',
          reason: 'verify failed',
        },
      ],
    });
    expect(text).toContain('# build r1');
    expect(text).toContain('wall time: 12m 30s');
    expect(text).toContain('restored from a killed run: page:index#s02-hero');
    expect(text).toContain('## passed (1)');
    expect(text).toContain('- page:about#s01-header (1 round)');
    expect(text).toContain('## blocked (1)');
    expect(text).toContain('- page:index#s01-header: rounds_exhausted');
    expect(text).toContain('/p/runs/r1/x/round-2/verify/verify.json');
    expect(text).toContain('| page:index#s01-header | 2 | blocked | verify failed |');
    expect(text).toContain('waited for rate limits 1 time, 60s in total');
    expect(text).toContain('## not started (6)');
    // a dependent of a blocked unit is never scheduled and never cascaded again, so the report
    // is the only place a reader learns why it never ran
    expect(text).toContain('- page:index (captured), waiting on page:index#s01-header');
    // and a unit whose dependency passed says nothing beyond its status
    expect(text).toContain('- page:about (captured)\n');
    expect(text).not.toContain('- page:about (captured), waiting');
  });
});

describe('reportText after a hard kill', () => {
  it('puts what was left in flight under its own heading, not under not started', () => {
    const m = site();
    transition(m, 'page:index#s01-header', { type: 'build_started' }, AT);
    const text = reportText(m, {
      run: 'r1',
      root: '/p',
      project: '/b',
      target: 'http://127.0.0.1:3000',
      claude: 'claude',
      options: { parallel: 2, rounds: 2, threshold: null },
      startedAt: AT,
      endedAt: null,
      restored: [],
      rounds: [],
    });
    expect(text).toContain('## interrupted (1)');
    expect(text).toContain('- page:index#s01-header (building)');
    expect(text).toContain('## not started (7)');
    // no end time: the report says the run is still going rather than inventing one
    expect(text).toContain('(still running)');
  });
});
