/**
 * Loads a recorded trace with Playwright's OWN trace loader, so tests assert
 * against the code trace.playwright.dev actually runs rather than against a
 * re-implementation that could share a mistake with the recorder.
 *
 * Why this exists next to `snapshotOracle.ts`: that helper drives
 * `SnapshotStorage.addFrameSnapshot` directly, which BYPASSES the trace
 * modernizer. The modernizer is where a trace's snapshot `phase` is derived
 * (`_modernize_8_to_9` maps `snapshotName` -> phase from the declaring action
 * event), and it is the only place a wrong emission order shows up: a
 * frame-snapshot written before the event that names it gets `phase = undefined`,
 * registers no renderer, and every action renders blank. `addFrameSnapshot`
 * would happily render such a trace, so a regression could pass the older
 * oracle and still be broken in the real viewer.
 *
 * It ALSO cannot use the test project's own `playwright-core`: that is pinned at
 * 1.59.1, whose modernizer stops at v8 and therefore still resolves snapshots by
 * `snapshotByName(pageId, "after@call@…")`. Verified empirically — against a
 * known-broken trace it reports every phase as reachable, exactly like against a
 * fixed one, so it cannot discriminate the defect at all.
 *
 * The discriminating loader is the 1.63 line, installed under an npm alias
 * (`playwright-core-163`) so it does not upgrade the driver that the browser
 * fixtures run on. When that alias is absent the helper reports
 * `available: false` and the spec falls back to its static order assertions
 * rather than passing vacuously.
 */

import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';

const require_ = createRequire(__filename);

/** The Playwright line that first derives `phase` from the declaring event. */
const PHASE_AWARE_ALIAS = 'playwright-core-163';

export type PhaseReport = {
  available: boolean;
  reason?: string;
  /** The playwright-core version that produced the report. */
  version?: string;
  /** Snapshot names the loader accepted, keyed `callId/phase`. */
  phases: string[];
  /** How many actions resolved at least one DOM snapshot phase. */
  renderableActions: number;
  totalActions: number;
  /** `callId` -> phases present, for assertions that need per-action detail. */
  perAction: Record<string, string[]>;
};

/** Reads a trace directory as the loader backend expects (flat posix names). */
function dirEntries(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const item of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) walk(path.join(d, item.name), rel);
      else out.push(rel);
    }
  };
  walk(dir, '');
  return out;
}

type LoaderModule = {
  TraceLoader: new () => {
    load(backend: unknown): Promise<void>;
    storage(): any;
    contextEntries: any[];
  };
};

/**
 * Resolves the phase-aware TraceLoader. Only the aliased 1.63+ line is accepted:
 * an older loader answers "yes" to every phase, which would make the caller's
 * assertion vacuous.
 */
function resolveLoader(): { mod: LoaderModule; version: string; entry: string } | null {
  let corePath: string;
  let version: string;
  try {
    corePath = require_.resolve(`${PHASE_AWARE_ALIAS}/package.json`);
    version = (require_(corePath) as { version?: string }).version ?? 'unknown';
    corePath = corePath.replace(/[\\/]package\.json$/, '');
  } catch {
    return null;
  }

  const entry = `${corePath}/lib/coreBundle.js`;
  if (!fs.existsSync(entry)) return null;
  try {
    const mod = require_(entry);
    const iso = mod.iso ?? mod;
    const TraceLoader = iso.TraceLoader ?? mod.TraceLoader;
    if (!TraceLoader) return null;
    return { mod: { TraceLoader }, version, entry };
  } catch {
    return null;
  }
}

/**
 * Loads the trace at `dir` and reports which action phases have a DOM snapshot
 * the viewer can actually reach.
 */
export async function inspectPhases(dir: string): Promise<PhaseReport> {
  const empty: PhaseReport = {
    available: false, phases: [], renderableActions: 0, totalActions: 0, perAction: {},
  };

  const resolved = resolveLoader();
  if (!resolved) {
    return {
      ...empty,
      reason: `the phase-aware loader (${PHASE_AWARE_ALIAS} = playwright-core@1.63) is not ` +
        'installed; an older playwright-core cannot tell a broken trace from a fixed one',
    };
  }

  const backend = {
    isLive: () => false,
    entryNames: async () => dirEntries(dir),
    readText: async (name: string) => {
      const p = path.join(dir, name);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : undefined;
    },
    readFile: async (name: string) => {
      const p = path.join(dir, name);
      return fs.existsSync(p) ? fs.readFileSync(p) : undefined;
    },
  };

  const instance = new resolved.mod.TraceLoader();
  await instance.load(backend);

  const context = instance.contextEntries[0];
  if (!context) {
    return { ...empty, available: true, version: resolved.version, reason: 'trace has no context entry' };
  }

  const storage = instance.storage();
  const perAction: Record<string, string[]> = {};
  const phases: string[] = [];
  let renderableActions = 0;

  for (const action of context.actions) {
    const found: string[] = [];
    for (const phase of ['before', 'action', 'after']) {
      // `snapshotForCall` is the phase-aware API. Its presence is also how this
      // helper tells a modern loader from a legacy one.
      if (typeof storage.snapshotForCall !== 'function') {
        return {
          ...empty,
          available: false,
          version: resolved.version,
          reason: `loader ${resolved.version} exposes no snapshotForCall; ` +
            'it cannot resolve phases',
        };
      }
      if (storage.snapshotForCall(action.callId, phase)) {
        found.push(phase);
        phases.push(`${action.callId}/${phase}`);
      }
    }
    perAction[action.callId] = found;
    if (found.length) renderableActions++;
  }

  return {
    available: true,
    version: resolved.version,
    phases,
    renderableActions,
    totalActions: context.actions.length,
    perAction,
  };
}
