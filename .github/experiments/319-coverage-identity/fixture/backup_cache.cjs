// Proposed fixture control; not executed during the read-only assessment.
const path = require('node:path');
const crypto = require('node:crypto');

// Shared namespace calculation without importing remote backup workflows.
const repositoryCacheDirectory = (root, destination) => path.join(root,
  crypto.createHash('sha256').update(JSON.stringify(['github.com', destination.ownerId, destination.id, destination.branch])).digest('hex'));

module.exports = { repositoryCacheDirectory };
