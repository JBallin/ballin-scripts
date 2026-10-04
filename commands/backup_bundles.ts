// Exact storage-name cutover; old names are retired, never aliases.
const directoryBundleRenames = new Map([
  ['codex_profiles.json', 'codex_profiles.bundle.json'],
  ['codex_skills.json', 'codex_skills.bundle.json'],
  ['codex_user_skills.json', 'codex_user_skills.bundle.json'],
  ['codex_rules.json', 'codex_rules.bundle.json'],
  ['codex_agents.json', 'codex_agents.bundle.json'],
  ['claude_rules', 'claude_rules.bundle.json'],
  ['claude_agents', 'claude_agents.bundle.json'],
  ['claude_commands', 'claude_commands.bundle.json'],
]);

module.exports = { directoryBundleRenames };
