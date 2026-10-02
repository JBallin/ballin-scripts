const { approvedSensitiveSourceRevision } = require('../commands/backup_config.ts');
const { observeSnapshotSources, snapshotDefinitions } = require('../commands/backup_snapshots.ts');
import type { SnapshotDefinition, SnapshotSourceObservation } from '../commands/backup_snapshots.ts';

describe('Codex sensitive-source consent', () => {
  [undefined, null, false, true, 0, 1, '1', 3, '3', 'invalid', {}, []].forEach((version) => {
    it(`treats missing or unrecognized revision ${JSON.stringify(version)} conservatively`, () => {
      assert.equal(approvedSensitiveSourceRevision({ backup: { sensitiveSourcesVersion: version } }), 1);
    });
  });
  it('accepts only the current explicitly saved numeric or string revision', () => {
    [2, '2'].forEach((version) => assert.equal(approvedSensitiveSourceRevision({ backup: { sensitiveSourcesVersion: version } }), 2));
    assert.equal(approvedSensitiveSourceRevision({}), 1);
    assert.equal(approvedSensitiveSourceRevision({ backup: [] }), 1);
  });

  it('never exports or restores local consent revision from portable preferences', () => {
    const { projectPortablePreferences, restorePortablePreferences } = require('../config/portable.ts');
    const local = { backup: { includeSensitive: 'true', sensitiveSourcesVersion: 1 } };
    const remote = { backup: { includeSensitive: 'true', sensitiveSourcesVersion: 2 } };
    assert.notProperty(projectPortablePreferences(local), 'backup');
    assert.deepEqual(restorePortablePreferences(local, local, remote), local);
    assert.deepEqual(restorePortablePreferences({}, {}, remote), {});
  });

  [
    { sensitive: true, revision: undefined, selected: false },
    { sensitive: true, revision: 1, selected: false },
    { sensitive: true, revision: 2, selected: true },
    { sensitive: false, revision: 2, selected: false },
    { sensitive: true, revision: 3, selected: false },
  ].forEach(({ sensitive, revision, selected }) => {
    it(`gates discovery itself for consent ${sensitive}, revision ${revision}`, () => {
      const definitions = snapshotDefinitions as SnapshotDefinition[];
      const originals = definitions.map((definition) => definition.discover);
      const discovered: string[] = [];
      try {
        definitions.forEach((definition) => {
          definition.discover = () => {
            discovered.push(definition.name);
            return { status: 'absent', reason: 'source-not-found', source: { kind: 'file', name: 'synthetic', path: '/synthetic-only/source' } };
          };
        });
        const observations: SnapshotSourceObservation[] = observeSnapshotSources({ homeDir: '/synthetic-only', env: { PATH: '', CODEX_HOME: '/synthetic-only/codex' } }, sensitive, revision);
        const codex = observations.filter(({ definition }) => definition.category === 'codex');
        assert.isNotEmpty(codex);
        codex.forEach(({ definition, status }) => {
          assert.equal(discovered.includes(definition.name), selected);
          assert.equal(status, selected ? 'absent' : 'excluded-by-policy');
        });
        assert.equal(discovered.includes('zshrc.sh'), sensitive && revision !== 3);
        assert.include(discovered, 'ballin_config');
      } finally {
        definitions.forEach((definition, index) => { definition.discover = originals[index]; });
      }
    });
  });
});
