const { savedPreferenceLine } = require('../commands/preference_confirmation.ts');

describe('explicit saved preference copy', () => {
  for (const [key, description, yes, no] of [
    ['backup.includeSensitive', 'Sensitive sources in backups', 'included', 'excluded'],
    ['update.backup', 'Automatic backup during updates', 'enabled', 'disabled'],
    ['analytics.enabled', 'Usage analytics', 'enabled', 'disabled'],
  ]) {
    for (const value of [false, true]) {
      it(`describes changed and unchanged ${key}=${value} without claiming a config command ran`, () => {
        const prefix = `${description}: ${value ? yes : no} (\`${key}\` `;
        assert.equal(savedPreferenceLine(key, value, !value), `${prefix}set to \`${value}\`).`);
        assert.equal(savedPreferenceLine(key, value, undefined), `${prefix}set to \`${value}\`).`);
        for (const previous of [value, String(value)]) {
          assert.equal(savedPreferenceLine(key, value, previous), `${prefix}unchanged at \`${value}\`).`);
        }
      });
    }
  }
});
