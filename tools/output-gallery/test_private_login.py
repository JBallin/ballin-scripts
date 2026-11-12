#!/usr/bin/env python3
"""Exercise the launcher with stub tools in a PTY; never authenticate."""
import errno
import os
from pathlib import Path
import pty
import subprocess
import tempfile
import unittest

LAUNCHER = Path(__file__).with_name('private-login.sh')


class PrivateLoginTests(unittest.TestCase):
    def run_launcher(self, *, git_exit=0, login_exit=0, token='', tty=True, missing=None, acknowledgement='test-account\n'):
        with tempfile.TemporaryDirectory(prefix='ballin-login-test-') as folder:
            root = Path(folder)
            for name, body in {
                'uname': 'echo Linux',
                'git': f'echo git >> "$CALLS"; exit {git_exit}',
                'gh': '''if [ "$1" = --version ]; then exit 0; fi
printf '%s\\n' "$*" >> "$CALLS"
printf 'env:%s:%s:%s:%s\\n' "$GH_PROMPT_DISABLED" "$GH_BROWSER" "$BROWSER" "$GH_DEBUG" >> "$CALLS"
if read -r ignored; then exit 91; fi
printf 'private-stub-instructions\\n'
exit ''' + str(login_exit),
            }.items():
                if name == missing:
                    continue
                tool = root / name
                tool.write_text('#!/bin/bash\n' + body + '\n')
                tool.chmod(0o755)
            calls = root / 'calls'
            env = {'PATH': str(root), 'HOME': str(root),
                   'CALLS': str(calls), 'GH_TOKEN': token, 'GH_DEBUG': 'api'}
            if tty:
                # Isolate the stub process in its own controlling Terminal.
                pid, master = pty.fork()
                if pid == 0:
                    os.execve('/bin/bash', ['bash', str(LAUNCHER)], env)
                output = b''
                os.write(master, acknowledgement.encode())
                while True:
                    try:
                        data = os.read(master, 4096)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        break
                    if not data:
                        break
                    output += data
                os.close(master)
                _, status = os.waitpid(pid, 0)
                code = os.waitstatus_to_exitcode(status)
            else:
                result = subprocess.run(['/bin/bash', str(LAUNCHER)], env=env,
                                        capture_output=True, timeout=10)
                code, output = result.returncode, result.stdout + result.stderr
            return code, output.decode(), calls.read_text() if calls.exists() else ''

    def test_private_manual_flow_and_exit_not_account_verification(self):
        code, output, calls = self.run_launcher()
        self.assertEqual(code, 0, output)
        self.assertIn('auth login --hostname github.com --git-protocol https --web --clipboard=false --expiring=false', calls)
        self.assertIn('env:1:/usr/bin/true:/usr/bin/true:\n', calls)
        self.assertIn('private-stub-instructions', output)
        self.assertIn('Verify the intended account privately', output)
        self.assertIn('can read or use its token', output)
        self.assertIn('dedicated minimal-access disposable', output)

    def test_declined_or_incomplete_acknowledgement_never_starts_tools(self):
        for answer in ['\n', 'yes\n', 'test-account-extra\n', '\x04']:
            with self.subTest(answer=repr(answer)):
                code, output, calls = self.run_launcher(acknowledgement=answer)
                self.assertNotEqual(code, 0)
                self.assertIn('Login cancelled', output)
                self.assertEqual(calls, '')
                self.assertNotIn('private-stub-instructions', output)

    def test_missing_prerequisites_block_login(self):
        for tool in ['git', 'gh']:
            code, output, calls = self.run_launcher(missing=tool)
            self.assertNotEqual(code, 0)
            self.assertIn('Install', output)
            self.assertNotIn('auth login', calls)

    def test_failed_git_blocks_login(self):
        code, output, calls = self.run_launcher(git_exit=1)
        self.assertNotEqual(code, 0)
        self.assertIn('Git is not working', output)
        self.assertNotIn('auth login', calls)

    def test_failed_login_never_claims_completion(self):
        code, output, _ = self.run_launcher(login_exit=1)
        self.assertNotEqual(code, 0)
        self.assertNotIn('Login command completed', output)
        self.assertIn('No authentication state has been verified', output)

    def test_recording_redirect_and_token_override_refused_before_tools(self):
        for kwargs in [{'tty': False}, {'token': 'synthetic-override'}]:
            code, output, calls = self.run_launcher(**kwargs)
            self.assertNotEqual(code, 0)
            self.assertEqual(calls, '')
            self.assertNotIn('synthetic-override', output)


if __name__ == '__main__':
    unittest.main()
