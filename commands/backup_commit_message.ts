const { snapshotDefinitions } = require('./backup_snapshots.ts');
import type { SnapshotDefinition } from './backup_snapshots.ts';

// Presentation labels refer only to canonical backup paths, never source contents,
// local paths, environment overrides, or names inside recursive bundles.
const sourceDescriptions = new Map<string, string>([
  ['bash_profile.sh', 'Bash profile'],
  ['bashrc.sh', 'Bash settings'],
  ['profile.sh', 'shell profile'],
  ['zprofile.sh', 'Zsh profile'],
  ['zshrc.sh', 'Zsh settings'],
  ['bash_completions', 'Bash completions'],
  ['brew_list', 'Homebrew formulae'],
  ['brew_leaves', 'Homebrew leaves'],
  ['brew_cask', 'Homebrew casks'],
  ['brew_services', 'Homebrew services'],
  ['Brewfile', 'Brewfile'],
  ['gitignore_global', 'Git ignores'],
  ['gitconfig', 'Git config'],
  ['npm_global', 'npm packages'],
  ['pipx', 'pipx packages'],
  ['uv_tools', 'uv tools'],
  ['pyenv_versions', 'Python versions'],
  ['nvmrc', 'Node version'],
  ['vs_settings', 'VS Code settings'],
  ['vs_keybindings', 'VS Code keybindings'],
  ['vs_extensions', 'VS Code extensions'],
  ['vsI_settings', 'VS Code Insiders settings'],
  ['vsI_keybindings', 'VS Code Insiders keybindings'],
  ['vsI_extensions', 'VS Code Insiders extensions'],
  ['vimrc', 'Vim settings'],
  ['nanorc', 'Nano settings'],
  ['codex_AGENTS.md', 'Codex instructions'],
  ['codex_AGENTS.override.md', 'Codex instruction overrides'],
  ['codex_config.toml', 'Codex config'],
  ['codex_profiles.bundle.json', 'Codex profiles'],
  ['codex_hooks.json', 'Codex hooks'],
  ['codex_skills.bundle.json', 'Codex skills'],
  ['codex_user_skills.bundle.json', 'Codex user skills'],
  ['codex_rules.bundle.json', 'Codex rules'],
  ['codex_agents.bundle.json', 'Codex agents'],
  ['codex_marketplace.json', 'Codex marketplace'],
  ['claude_instructions', 'Claude instructions'],
  ['claude_rules.bundle.json', 'Claude rules'],
  ['claude_agents.bundle.json', 'Claude agents'],
  ['claude_commands.bundle.json', 'Claude commands'],
  ['claude_skills.bundle.json', 'Claude skills'],
  ['ballin_config', 'update preferences'],
  ['mas', 'Mac App Store apps'],
]);
const subjectLimit = 72;

const backupCommitMessage = (changedPaths: Iterable<string>): { headline: string; body?: string } => {
  const changed = new Set(changedPaths);
  // Catalog order is stable across input order, additions, and removed sources.
  // Unknown paths receive generic copy rather than exposing arbitrary filenames.
  const sources = (snapshotDefinitions as readonly SnapshotDefinition[])
    .filter(({ name }) => changed.delete(name))
    .map(({ name }) => ({ name, description: sourceDescriptions.get(name) ?? 'backup source' }));
  const descriptions = sources.map(({ description }) => description);
  if (changed.size) descriptions.push('other sources');
  if (!descriptions.length) return { headline: 'Update: backup sources' };
  const headline = `Update: ${descriptions.join(', ')}`;
  if (headline.length <= subjectLimit) return { headline };
  const shortenedSubject = (count: number): string => {
    return `Update: ${descriptions.slice(0, count).join(', ')}, +${descriptions.length - count} more`;
  };
  let count = descriptions.length - 1;
  // Fixed labels leave room for at least one source and the remainder count.
  while (count > 1 && shortenedSubject(count).length > subjectLimit) count--;
  return {
    headline: shortenedSubject(count),
    body: ['Changed sources:', ...sources.map(({ name, description }) => `- ${description} (${name})`),
      ...(changed.size ? ['- Other sources'] : [])].join('\n'),
  };
};

module.exports = { backupCommitMessage };
