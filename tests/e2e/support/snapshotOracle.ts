/**
 * Renders trace snapshots with Playwright's own SnapshotRenderer so that tests
 * are checked against the code the trace viewer actually runs, instead of a
 * re-implementation of the back-reference format that could share a mistake with
 * the recorder.
 *
 * These modules are internal and not exported by the package, so the deep import
 * is resolved by path and isolated here — a Playwright upgrade can move it.
 */

const corePath = require.resolve('playwright-core').replace(/[\\/]index\.js$/, '');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SnapshotStorage } = require(`${corePath}/lib/utils/isomorphic/trace/snapshotStorage`);

export type RenderedSnapshot = { name: string; frameId: string; html: string };

/**
 * Expands `frame-snapshot` trace lines into full HTML documents.
 *
 * All snapshots must be passed together and in emission order: a back-reference
 * addresses an earlier snapshot by how many positions back it sits, so a partial
 * or reordered list resolves to the wrong nodes. Frames are tracked separately
 * inside SnapshotStorage, exactly as the viewer does.
 */
export function renderSnapshots(frameSnapshotLines: any[]): RenderedSnapshot[] {
  const storage = new SnapshotStorage();
  const renderers = frameSnapshotLines.map(
    line => storage.addFrameSnapshot('context@test', line.snapshot, [])
  );
  return renderers.map((renderer: any, i: number) => ({
    name: frameSnapshotLines[i].snapshot.snapshotName,
    frameId: frameSnapshotLines[i].snapshot.frameId,
    html: String(renderer.render().html)
  }));
}
