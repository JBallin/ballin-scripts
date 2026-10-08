import type { RepositoryError } from './backup_repository.ts';
const { RepositoryError: BackupRepositoryError } = require('./backup_repository.ts') as {
  RepositoryError: typeof RepositoryError;
};

export type BackupFailureCategory = 'transport' | 'authentication' | 'reconciliation' | 'local_state' | 'unknown';
export type BackupFailureEvidence = { category?: BackupFailureCategory };

// Retain only a bounded family. Competing or unsupported evidence stays unknown.
const observeBackupFailure = (evidence: BackupFailureEvidence, category: BackupFailureCategory): void => {
  evidence.category = evidence.category === undefined || evidence.category === category ? category : 'unknown';
};
const observeRepositoryFailure = (evidence: BackupFailureEvidence, error: unknown): void => {
  let category: BackupFailureCategory = 'unknown';
  if (error instanceof BackupRepositoryError) {
    if (error.publicationConfirmed && error.cleanupFailed) category = 'local_state';
    else if (error.problem === 'connection' || error.problem === 'timeout') category = 'transport';
    else if (error.problem === 'authentication') category = 'authentication';
    else if (error.problem === 'moved' || (error.problem === 'rejected' && error.reconciliationFailed)) category = 'reconciliation';
    else if (error.problem === 'local-io' || error.problem === 'cleanup') category = 'local_state';
  }
  observeBackupFailure(evidence, category);
  if (error instanceof BackupRepositoryError && error.cleanupFailed) observeBackupFailure(evidence, 'local_state');
};
module.exports = { observeBackupFailure, observeRepositoryFailure };
