const { isConfigObject, sensitiveSourceConsent } = require('./backup_config.ts');
import type { ConfigObject } from './backup_config.ts';

const preferenceState = (value: unknown, key: string, enabled: string, disabled: string): string => {
  if (value === true || value === 'true') return enabled;
  if (value === false || value === 'false') return disabled;
  return `invalid \`${key}\` (expected true or false)`;
};

// The caller validates the destination; presentation performs no inspection or writes.
const validatedBackupSummary = (destinationUrl: string, config: ConfigObject, showSummary = true): string => {
  const automatic = isConfigObject(config.update) ? (config.update as ConfigObject).backup : undefined;
  // CLI help imports this module, so load bundled defaults only when rendering.
  const effectiveAutomatic = automatic === undefined ? require('../config/.defaultConfig.json').update.backup : automatic;
  const sensitive = sensitiveSourceConsent(config);
  const preferences = [
    { value: sensitive, line: `Sensitive sources: ${preferenceState(sensitive, 'backup.includeSensitive', 'included', 'excluded')}` },
    { value: effectiveAutomatic, line: `Automatic backup during update: ${preferenceState(effectiveAutomatic, 'update.backup', 'enabled', 'disabled')}` },
  ];
  // Embedded validation still reports malformed settings that need attention.
  const visiblePreferences = showSummary ? preferences : preferences.filter(({ value }) => (
    value !== true && value !== false && value !== 'true' && value !== 'false'
  ));
  return [
    ...(showSummary ? [`Validated private backup: ${destinationUrl}`] : []),
    ...visiblePreferences.map(({ line }) => line),
  ].join('\n');
};

module.exports = { validatedBackupSummary };
