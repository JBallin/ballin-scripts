#!/usr/bin/env python3
"""Focused data-fidelity and renderer rejection tests; no product execution."""
import importlib.util
import json
import os
import shutil
from pathlib import Path
import subprocess
import tempfile
import unittest

TOOLS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('gallery', TOOLS / 'run.py')
gallery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gallery)


class GalleryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='ballin-renderer-test-')
        cls.root = Path(cls.temp.name)
        cls.renderer = cls.root / 'render'
        subprocess.run(['swiftc', '-module-cache-path', str(cls.root / 'cache'),
                        str(TOOLS / 'render.swift'), '-o', str(cls.renderer)], check=True, timeout=120)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def render(self, text, name):
        prefix = self.root / name
        result = subprocess.run([str(self.renderer), str(prefix)], input=text.encode(), capture_output=True, timeout=30)
        return result, prefix

    def test_styled_text_unicode_tabs_long_lines_and_pagination(self):
        text = '\x1b[1;36mAccepted: Yes\x1b[0m\n\x1b[31mFailure\ncontinued\x1b[0m\nUnicode: café ✓ end\n' + ('long ' * 80 + '\n') * 65
        result, prefix = self.render(text, 'styled')
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(prefix.with_suffix('.json').read_text())
        self.assertEqual(report['text'], gallery.plain_text(text))
        self.assertGreater(len(report['pages']), 1)
        for page in report['pages']:
            self.assertEqual((self.root / page).read_bytes()[:8], b'\x89PNG\r\n\x1a\n')

    def test_rejects_mixed_supported_and_unsupported_escapes(self):
        for index, text in enumerate(['\x1b[32mok\x1b[2Jhidden', '\x1b[38;5;100munsupported', '\x1b[999999999999999999999999999999moverflow', 'tab\there', 'delete\x7fhere', 'c1\x9bhere', '\x1b]8;;https://example.com\x07link']):
            result, _ = self.render(text, 'bad-' + str(index))
            self.assertNotEqual(result.returncode, 0)

    def test_empty_input_and_partial_lines(self):
        result, _ = self.render('', 'empty')
        self.assertNotEqual(result.returncode, 0)
        result, prefix = self.render('without trailing newline', 'partial')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(prefix.with_suffix('.json').read_text())['text'], 'without trailing newline')

    def test_plain_text_normalization_rejects_redraw(self):
        self.assertEqual(gallery.plain_text('\x1b[1mhello\x1b[0m\r\n'), 'hello\n')
        for control in ['\r', '\b', '\x1b[2K', '\x07', '\x7f', '\x9b']:
            with self.assertRaises(ValueError):
                gallery.plain_text('safe' + control)

    def test_refuses_moving_source_without_creating_output(self):
        output = self.root / 'must-not-exist'
        result = subprocess.run(['python3', str(TOOLS / 'run.py'), '--source', 'HEAD', '--output', str(output)], capture_output=True, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output.exists())


class GallerySecurityTests(unittest.TestCase):
    def test_candidate_formatter_and_expression_never_execute(self):
        repo = TOOLS.parents[1]
        with tempfile.TemporaryDirectory(prefix='ballin-candidate-security-') as temp:
            root = Path(temp)
            clone = root / 'repo.git'
            subprocess.run(['git', 'clone', '--bare', '--shared', '--quiet', str(repo), str(clone)], check=True, timeout=20)
            env = {**os.environ, 'GIT_INDEX_FILE': str(root / 'index'),
                   'GIT_AUTHOR_NAME': 'Gallery test fixture', 'GIT_AUTHOR_EMAIL': 'fixture@example.invalid',
                   'GIT_COMMITTER_NAME': 'Gallery test fixture', 'GIT_COMMITTER_EMAIL': 'fixture@example.invalid'}
            def git(*args, data=None):
                return subprocess.check_output(['git', '--git-dir', str(clone), *args], input=data, env=env).decode().strip()
            baseline = git('rev-parse', 'HEAD')
            for index, name in enumerate(['commands/terminalStyle.ts', 'commands/repo_update.ts']):
                marker = root / ('executed-' + str(index))
                source = subprocess.check_output(['git', '--git-dir', str(clone), 'show', baseline + ':' + name]).decode()
                payload = "require('node:fs').writeFileSync(" + json.dumps(str(marker)) + ", 'executed')"
                if index == 0:
                    source += '\n' + payload + ';\n'
                else:
                    source = source.replace("s.kind === 'release' ? s.value :", "(" + payload + ", s.kind === 'release') ? s.value :", 1)
                blob = git('hash-object', '-w', '--stdin', data=source.encode())
                git('read-tree', baseline)
                git('update-index', '--cacheinfo', '100644,' + blob + ',' + name)
                tree = git('write-tree')
                candidate = git('commit-tree', tree, '-p', baseline, data=b'Test-only candidate data\n')
                output = root / ('output-' + str(index))
                result = subprocess.run(['python3', str(TOOLS.parent / 'pr-662-output-gallery' / 'build.py'),
                                         '--root', str(clone), '--output', str(output), '--candidate', candidate], capture_output=True, timeout=30)
                if result.returncode == 0:
                    shutil.copy2(TOOLS.parent / 'pr-662-output-gallery' / 'verify.py', output)
                    subprocess.run(['python3', str(output / 'verify.py')], capture_output=True, timeout=30)
                self.assertFalse(marker.exists(), 'Unreviewed candidate executed its marker payload')
                self.assertNotEqual(result.returncode, 0, 'Builder accepted unreviewed executable bytes')
                self.assertIn(b'Unreviewed gallery runtime', result.stderr)


    def test_direct_replay_rejects_mutated_runtime_even_with_matching_provenance(self):
        with tempfile.TemporaryDirectory(prefix='ballin-replay-security-') as temp:
            output = Path(temp) / 'runtime'
            shutil.copytree(TOOLS.parent / 'pr-662-output-gallery', output)
            marker = Path(temp) / 'executed'
            name = 'selection_label.cjs'
            target = output / name
            target.write_text(target.read_text() + "\nrequire('node:fs').writeFileSync(" + json.dumps(str(marker)) + ", 'executed');\n")
            manifest = json.loads((output / 'provenance.json').read_text())
            manifest['sources'][name] = gallery.digest(target)
            (output / 'provenance.json').write_text(json.dumps(manifest))
            for command in [['python3', str(output / 'verify.py')],
                            ['node', str(output / 'gallery.cjs')],
                            ['bash', str(output / 'run.command')]]:
                result = subprocess.run(command, capture_output=True, timeout=30)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b'Unreviewed gallery runtime', result.stderr)
                self.assertFalse(marker.exists(), 'Direct replay executed unreviewed runtime')


if __name__ == '__main__':
    unittest.main()
