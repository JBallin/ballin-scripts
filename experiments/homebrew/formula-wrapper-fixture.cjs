// Executes only the generated wrapper write in caller-owned temporary paths.
// This is not a Homebrew installation or a replacement for formula validation.
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function renderFormulaWrapper({ formula, node, libexec, bin }) {
  const start = formula.indexOf('    (bin/"ballin").write ');
  const end = formula.indexOf('\n  end\n\n  def caveats', start);
  assert.ok(start >= 0 && end > start, 'Expected generated wrapper at the end of install');
  const body = formula.slice(start, end);
  const setup = 'node, libexec, bin = ARGV.map { |value| Pathname.new(value) }; ';
  execFileSync('/usr/bin/ruby', ['-rpathname', '-rshellwords', '-e', setup + body, node, libexec, bin], {
    env: { PATH: '/usr/bin:/bin', HOME: bin, TMPDIR: bin },
    encoding: 'utf8',
  });
  return path.join(bin, 'ballin');
}

module.exports = { renderFormulaWrapper };
