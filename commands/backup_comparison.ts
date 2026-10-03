type SnapshotComparison =
  | { status: 'match' | 'change' }
  | { status: 'conflict'; reason: string };

// Shared writer/verifier decisions. Presence is distinct from empty bytes.
const compareSnapshotState = (
  baseExists: boolean,
  remoteExists: boolean,
  localMatchesRemote: boolean,
  baseMatchesRemote: boolean,
): SnapshotComparison => {
  if (!baseExists && !remoteExists) return { status: 'change' };
  if (!baseExists && !localMatchesRemote) {
    return { status: 'conflict', reason: 'remote content differs and this machine has no cached base' };
  }
  if (baseExists && !remoteExists) {
    return { status: 'conflict', reason: 'the remote file is missing but this machine has a cached base' };
  }
  if (localMatchesRemote) return { status: 'match' };
  if (baseMatchesRemote) return { status: 'change' };
  return { status: 'conflict', reason: 'remote content diverged from the cached base and staged local content' };
};

module.exports = { compareSnapshotState };
export type { SnapshotComparison };
