const path = require('node:path') as typeof import('node:path');
const crypto = require('node:crypto') as typeof import('node:crypto');
import type { RepositoryDestination } from './backup_config.ts';

// Shared namespace calculation without importing remote backup workflows.
const repositoryCacheDirectory = (root: string, destination: RepositoryDestination): string => path.join(root,
  crypto.createHash('sha256').update(JSON.stringify(['github.com', destination.ownerId, destination.id, destination.branch])).digest('hex'));

module.exports = { repositoryCacheDirectory };
