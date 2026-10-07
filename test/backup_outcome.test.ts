const { RepositoryError } = require('../commands/backup_repository.ts');
const { observeBackupFailure, observeRepositoryFailure } = require('../commands/backup_outcome.ts');
import type { BackupFailureEvidence } from '../commands/backup_outcome.ts';

describe('backup terminal failure evidence', () => {
  it('classifies typed repository evidence and leaves ambiguous causes unknown', () => {
    for (const [problem, expected] of [
      ['connection', 'transport'], ['timeout', 'transport'], ['authentication', 'authentication'],
      ['moved', 'reconciliation'], ['local-io', 'local_state'], ['cleanup', 'local_state'],
      ['request', 'unknown'], ['unavailable', 'unknown'], ['identity', 'unknown'], ['unsupported', 'unknown'],
      ['feature-settings', 'unknown'], ['invalid-data', 'unknown'], ['incomplete', 'unknown'],
      ['rejected', 'unknown'], ['uncertain', 'unknown'],
    ]) {
      const evidence: BackupFailureEvidence = {};
      observeRepositoryFailure(evidence, new RepositoryError(problem));
      assert.equal(evidence.category, expected, problem);
    }
    const stale = new RepositoryError('rejected'); stale.reconciliationFailed = true;
    const evidence: BackupFailureEvidence = {};
    observeRepositoryFailure(evidence, stale);
    assert.equal(evidence.category, 'reconciliation');
    for (const error of [new Error('authentication /private/DUMMY_SECRET'), { problem: 'authentication' }, null]) {
      const evidence: BackupFailureEvidence = {};
      observeRepositoryFailure(evidence, error);
      assert.deepEqual(evidence, { category: 'unknown' });
    }
  });

  it('preserves a single family but falls back for competing or unsupported evidence', () => {
    const evidence: BackupFailureEvidence = {};
    observeBackupFailure(evidence, 'transport');
    observeBackupFailure(evidence, 'transport');
    assert.equal(evidence.category, 'transport');
    observeBackupFailure(evidence, 'local_state');
    observeBackupFailure(evidence, 'transport');
    assert.equal(evidence.category, 'unknown');
    const confirmed = new RepositoryError('invalid-data');
    confirmed.cleanupFailed = true; confirmed.publicationConfirmed = true;
    const remaining: BackupFailureEvidence = {};
    observeRepositoryFailure(remaining, confirmed);
    assert.equal(remaining.category, 'local_state');
    for (const problem of ['connection', 'authentication', 'cleanup', 'uncertain']) {
      const error = new RepositoryError(problem); error.cleanupFailed = true;
      const evidence: BackupFailureEvidence = {};
      observeRepositoryFailure(evidence, error);
      assert.equal(evidence.category, problem === 'cleanup' ? 'local_state' : 'unknown');
    }
  });
});
