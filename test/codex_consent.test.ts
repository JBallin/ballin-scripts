const { observeSnapshotSources, snapshotDefinitions } = require('../commands/backup_snapshots.ts');
import type { SnapshotDefinition, SnapshotSourceObservation } from '../commands/backup_snapshots.ts';

describe('Codex sensitive-source consent', () => {
  it('never exports or restores the local sensitive preference from portable preferences', () => {
    const { projectPortablePreferences, restorePortablePreferences } = require('../config/portable.ts');
    const local = { backup: { includeSensitive: 'false' } };
    const remote = { backup: { includeSensitive: 'true' } };
    assert.notProperty(projectPortablePreferences(local), 'backup');
    assert.deepEqual(restorePortablePreferences(local, local, remote), local);
    assert.deepEqual(restorePortablePreferences({}, {}, remote), {});
  });

  [false, true].forEach((sensitive) => {
    it(`gates discovery itself for sensitive consent ${sensitive}`, () => {
      const selected = sensitive;
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
        const observations: SnapshotSourceObservation[] = observeSnapshotSources({ homeDir: '/synthetic-only', env: { PATH: '', CODEX_HOME: '/synthetic-only/codex' } }, sensitive);
        const codex = observations.filter(({ definition }) => definition.category === 'codex');
        assert.isNotEmpty(codex);
        codex.forEach(({ definition, status }) => {
          assert.equal(discovered.includes(definition.name), selected);
          assert.equal(status, selected ? 'absent' : 'excluded-by-policy');
        });
        assert.equal(discovered.includes('zshrc.sh'), sensitive);
        assert.include(discovered, 'ballin_config');
      } finally {
        definitions.forEach((definition, index) => { definition.discover = originals[index]; });
      }
    });
  });
});
