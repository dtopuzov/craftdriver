/**
 * Post-action diff rendering.
 *
 * `renderDelta` is the only signal an agent gets about what its last action
 * did, so "no changes" has to mean it. A set-difference over line bodies
 * lost element multiplicity: deleting one of several identical rows
 * reported nothing, and the agent would reasonably retry the action.
 *
 * Pure function, no browser — cheap enough to cover the shapes exhaustively.
 */
import { describe, it, expect } from 'vitest';
import { renderDelta, type SnapshotShape } from '../../src/cli/snapshot';

function snap(lines: string[], over: Partial<SnapshotShape> = {}): SnapshotShape {
  return {
    url: 'http://example.test/',
    title: 'Test',
    lines,
    documentId: 'd1-aaaa',
    revision: 1,
    refs: [],
    nextRef: lines.length + 1,
    ...over,
  };
}

describe('renderDelta', () => {
  it('reports a removed element among identical siblings', () => {
    const before = snap(['e1: button "Remove"', 'e2: button "Remove"', 'e3: button "Remove"']);
    const after = snap(['e1: button "Remove"', 'e2: button "Remove"']);

    const delta = renderDelta(before, after);
    expect(delta).toContain('- e3: button "Remove"');
    expect(delta).not.toContain('no a11y changes');
  });

  it('reports an added element among identical siblings', () => {
    const before = snap(['e1: button "Remove"']);
    const after = snap(['e1: button "Remove"', 'e2: button "Remove"']);

    const delta = renderDelta(before, after);
    expect(delta).toContain('+ e2: button "Remove"');
  });

  it('stays quiet when nothing changed, including with duplicates', () => {
    const lines = ['e1: button "Remove"', 'e2: button "Remove"'];
    expect(renderDelta(snap(lines), snap(lines))).toContain('(no a11y changes)');
  });

  it('ignores renumbering alone', () => {
    // Refs are stripped before comparison, so a node keeping its identity
    // under a different number is not a change.
    const before = snap(['e1: button "Save"', 'e2: link "Help"']);
    const after = snap(['e7: button "Save"', 'e8: link "Help"']);
    expect(renderDelta(before, after)).toContain('(no a11y changes)');
  });

  it('reports both sides of a swap', () => {
    const before = snap(['e1: button "Save"', 'e2: link "Help"']);
    const after = snap(['e1: button "Save"', 'e3: link "Support"']);

    const delta = renderDelta(before, after);
    expect(delta).toContain('- e2: link "Help"');
    expect(delta).toContain('+ e3: link "Support"');
  });

  it('prints a full snapshot rather than a diff on a new document', () => {
    const before = snap(['e1: button "Save"'], { documentId: 'd1-aaaa' });
    const after = snap(['e9: heading "Welcome"'], { documentId: 'd2-bbbb' });

    const delta = renderDelta(before, after);
    expect(delta).toContain('e9: heading "Welcome"');
    expect(delta).not.toMatch(/^[-+] /m);
  });

  it('prints the full snapshot when there is no baseline', () => {
    expect(renderDelta(null, snap(['e1: button "Save"']))).toContain('e1: button "Save"');
  });
});
