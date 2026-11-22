import type { RepositoryError } from './backup_repository.ts';
const { RepositoryError: BackupRepositoryError, repositoryFailureCategory } = require('./backup_repository.ts') as {
  RepositoryError: typeof RepositoryError;
  repositoryFailureCategory: (problem: RepositoryError['confirmationProblem']) => BackupFailureCategory;
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
    const problem = error.problem === 'uncertain' ? error.confirmationProblem : error.problem;
    if (error.publicationConfirmed && error.cleanupFailed) category = 'local_state';
    else if (error.problem === 'rejected' && error.reconciliationFailed) category = 'reconciliation';
    else category = repositoryFailureCategory(problem);
    if (error.problem === 'uncertain' && error.mutationFailureFamily !== undefined) {
      observeBackupFailure(evidence, error.mutationFailureFamily);
    }
  }
  observeBackupFailure(evidence, category);
  if (error instanceof BackupRepositoryError && error.cleanupFailed) observeBackupFailure(evidence, 'local_state');
};
module.exports = { observeBackupFailure, observeRepositoryFailure };
