const { isConfigObject, sensitiveSourceConsent } = require('./backup_config.ts');
import type { ConfigObject } from './backup_config.ts';

const preferenceState = (value: unknown, key: string, enabled: string, disabled: string): string => {
  if (value === true || value === 'true') return enabled;
  if (value === false || value === 'false') return disabled;
  return `invalid \`${key}\` (expected true or false)`;
};

// The caller validates the destination; presentation performs no inspection or writes.
const validatedBackupSummary = (destinationUrl: string, config: ConfigObject): string => {
  const automatic = isConfigObject(config.update) ? (config.update as ConfigObject).backup : undefined;
  // CLI help imports this module, so load bundled defaults only when rendering.
  const effectiveAutomatic = automatic === undefined ? require('../config/.defaultConfig.json').update.backup : automatic;
  return [
    `Validated private backup: ${destinationUrl}`,
    `Sensitive sources: ${preferenceState(sensitiveSourceConsent(config), 'backup.includeSensitive', 'included', 'excluded')}`,
    `Automatic backup during update: ${preferenceState(effectiveAutomatic, 'update.backup', 'enabled', 'disabled')}`,
  ].join('\n');
};

module.exports = { validatedBackupSummary };
