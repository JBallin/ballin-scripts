const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const github = path.join(__dirname, '..', '.github');
const workflow = yaml.load(fs.readFileSync(path.join(github, 'workflows', 'ci.yml'), 'utf8'));

describe('Ubuntu CI prerequisites', () => {
  it('uses fixed Ubuntu 26.04 labels for every locally defined runner job', () => {
    for (const filename of fs.readdirSync(path.join(github, 'workflows'))) {
      const config = yaml.load(fs.readFileSync(path.join(github, 'workflows', filename), 'utf8'));
      for (const [name, job] of Object.entries(config.jobs)) {
        const runner = (job as { 'runs-on'?: string })['runs-on'];
        if (runner !== undefined) assert.equal(runner, 'ubuntu-26.04', `${filename}: ${name}`);
      }
    }
  });

  it('installs GNU separately and requires its exact executable for preflight', () => {
    const steps = workflow.jobs.test.steps;
    const install = steps.find((step: { name: string }) => step.name === 'Install shell tools');
    assert.include(install.run, 'sudo apt-get install --yes shellcheck zsh jq gnu-coreutils');
    assert.include(install.run, 'dpkg-query --show gnu-coreutils');
    assert.include(install.run, '/usr/bin/gnutimeout --version');
    const preflight = steps.find((step: { run?: string }) => step.run === 'npm run test:claude-preflight');
    assert.deepEqual(preflight.env, { GNU_TIMEOUT: '/usr/bin/gnutimeout' });
  });

  it('extends only the known runner label without disabling lint diagnostics', () => {
    const config = yaml.load(fs.readFileSync(path.join(github, 'actionlint.yaml'), 'utf8'));
    assert.deepEqual(config, { 'self-hosted-runner': { labels: ['ubuntu-26.04'] } });
    const step = workflow.jobs.test.steps.find((step: { name: string }) => step.name === 'Run actionlint');
    assert.include(step.run, 'rhysd/actionlint:1.7.12');
    assert.notInclude(step.run, '-ignore');
  });

  it('reports the actual image, OS and relevant tool paths and versions after Node setup', () => {
    const steps = workflow.jobs.test.steps;
    const report = steps.findIndex((step: { name: string }) => step.name === 'Report runner and tool versions');
    const node = steps.findIndex((step: { name: string }) => step.name === 'Set up Node.js');
    assert.isAbove(report, node);
    assert.include(steps[report].run, '${ImageOS:-unknown}');
    assert.include(steps[report].run, '${ImageVersion:-unknown}');
    assert.include(steps[report].run, 'cat /etc/os-release');
    assert.include(steps[report].run, 'for tool in bash jq /usr/bin/gnutimeout shellcheck zsh docker node npm; do');
    assert.include(steps[report].run, 'command -v "$tool"');
    assert.include(steps[report].run, '"$tool" --version');
  });
});
