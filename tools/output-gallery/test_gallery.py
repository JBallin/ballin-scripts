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
from unittest.mock import patch

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

    def render(self, text, name, presentation=None):
        prefix = self.root / name
        command = [str(self.renderer), str(prefix)]
        if presentation is not None:
            metadata = self.root / (name + '-presentation.json')
            metadata.write_text(json.dumps(presentation))
            command.append(str(metadata))
        result = subprocess.run(command, input=text.encode(), capture_output=True, timeout=30)
        return result, prefix

    def test_repeated_captions_and_small_case_pagination_preserve_transcript(self):
        label, source = 'STAGED — no live execution.', 'a' * 40
        lines = ['prefill ' + str(i) for i in range(44)] + [
            '[STAGED major release change]', 'Ballin: v1 → v2', 'Release notes: example',
            '? Change revision? Yes', 'Ballin updated: v1 to v2', '']
        header = label + '\nSource: ' + source + '\n\n'
        text = header + '\n'.join(lines)
        context = {'label': label, 'source': source, 'scenario': 'Update (staged-update)', 'keepTogether': [[44, 49]]}
        result, prefix = self.render(text, 'captions', context)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(prefix.with_suffix('.json').read_text())
        self.assertEqual(report['text'], text)
        self.assertEqual(len(report['pages']), 2)
        for index, caption in enumerate(report['pageCaptions'], 1):
            for value in [label, source, context['scenario'], f'Page {index} of 2']:
                self.assertIn(value, caption)
        self.assertTrue(any(set(range(44, 49)).issubset(page) for page in report['pageLineIndexes']))
        result, prefix = self.render(header + 'large case\n' * 100, 'large-case', {**context, 'keepTogether': [[0, 100]]})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(prefix.with_suffix('.json').read_text())['text'], header + 'large case\n' * 100)

    def test_actual_command_caption_preserves_output_and_pagination(self):
        header = 'ACTUAL VM CAPTURE\nSource: ' + 'a' * 40 + '\n\n'
        text = header + 'retained output\n' * 90
        context = dict(label='ACTUAL VM CAPTURE', source='a' * 40,
                       scenario='Read preferences', keepTogether=[], captionCommand='ballin backup read ballin_config')
        result, prefix = self.render(text, 'command-caption', context)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(prefix.with_suffix('.json').read_text())
        self.assertEqual(report['text'], text)
        self.assertGreater(len(report['pages']), 1)
        for index, caption in enumerate(report['pageCaptions'], 1):
            self.assertIn('$ ballin backup read ballin_config', caption)
            self.assertIn(f'Page {index} of ', caption)
            self.assertNotIn('Source:', caption)
        result, _ = self.render(text, 'unsafe-caption', {**context, 'captionCommand': 'ballin\nforged'})
        self.assertNotEqual(result.returncode, 0)

    def test_staged_notes_and_transition_cases_form_complete_blocks(self):
        text = '[STAGED alternative — NVM failed]\n\n[STAGED omission: upstream output]\n\nFailure\n\n' \
            '[STAGED alternative — transition scope]\n\n[STAGED major release]\nProposal\nConsent\nResult\n'
        self.assertEqual(gallery.staged_case_ranges(text), [[0, 6], [6, 12]])

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
        for index, text in enumerate(['\x1b[32mok\x1b[2Jhidden', '\x1b[38;5;100munsupported', '\x1b[999999999999999999999999999999moverflow', 'tab\there', 'delete\x7fhere', 'c1\x9bhere', '\x1b]8;;https://example.com\x07link',
                                     '\x1b[34m\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\\x1b[0m']):
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
        for control in ['\r', '\b', '\x1b[2K', '\x07', '\x7f', '\x9b',
                        '\x1b]8;;https://example.com\x1b\\label\x1b]8;;\x1b\\',
                        '\x1b[34m\x1b]8;;https://example.com\x07label\x1b]8;;\x07\x1b[0m']:
            with self.assertRaises(ValueError):
                gallery.plain_text('safe' + control)

    def test_canonical_update_example_is_static_and_matches_rendered_text(self):
        staged = self.root / 'update-example-runtime'
        staged.mkdir()
        (staged / 'terminalStyle.ts').write_bytes((TOOLS.parents[1] / 'commands/terminalStyle.ts').read_bytes())
        source = staged / 'source-evidence/commands/update.ts'
        source.parent.mkdir(parents=True)
        source.write_bytes((TOOLS.parents[1] / 'commands/update.ts').read_bytes())
        sample = TOOLS / 'update-example.txt'
        ansi = gallery.update_example(staged, sample)
        self.assertEqual(gallery.plain_text(ansi), sample.read_text())
        self.assertTrue(ansi.startswith('\x1b[1m$ ballin update'))
        self.assertIn('\x1b[0;32m✓\x1b[0m ballin_config', ansi)
        self.assertIn('~ \x1b[1mzshrc\x1b[0m', ansi)
        header = 'STAGED — source-informed synthetic output; no live execution.\nSource: ' + 'a' * 40 + '\n\n'
        result, prefix = self.render(header + ansi, 'canonical-update',
                                     {'label': 'STAGED — source-informed synthetic output; no live execution.', 'source': 'a' * 40,
                                      'scenario': 'Routine Update — condensed illustration', 'keepTogether': []})
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(prefix.with_suffix('.json').read_text())
        self.assertEqual(report['text'], header + sample.read_text())
        self.assertEqual(len(report['pages']), 1)
        self.assertIn('STAGED', report['pageCaptions'][0])
        # An altered candidate formatter must never execute, even when the
        # caller supplies source data that otherwise passes the phase checks.
        marker = staged / 'must-not-exist'
        runtime = staged / 'terminalStyle.ts'
        runtime.write_text(runtime.read_text() + '\nrequire("node:fs").writeFileSync(' + json.dumps(str(marker)) + ', "bad");\n')
        with self.assertRaisesRegex(ValueError, 'Unreviewed gallery runtime'):
            gallery.update_example(staged, sample)
        self.assertFalse(marker.exists())

    def test_update_example_accepts_reviewed_history_but_not_unknown_bytes(self):
        staged = self.root / 'historical-runtime'
        staged.mkdir()
        runtime = staged / 'terminalStyle.ts'
        runtime.write_bytes((TOOLS.parents[1] / 'commands/terminalStyle.ts').read_bytes())
        source = staged / 'source-evidence/commands/update.ts'
        source.parent.mkdir(parents=True)
        source.write_bytes((TOOLS.parents[1] / 'commands/update.ts').read_bytes())
        pins = self.root / 'historical-pins'
        pins.mkdir()
        trusted = {'executableHashes': {'terminalStyle.ts': '0' * 64},
                   'reviewedProfiles': [{'executableHashes': {'terminalStyle.ts': gallery.digest(runtime)}}]}
        (pins / 'generation-runtime.json').write_text(json.dumps(trusted))
        sample = TOOLS / 'update-example.txt'
        with patch.object(gallery, 'LEGACY', pins):
            self.assertEqual(gallery.plain_text(gallery.update_example(staged, sample)), sample.read_text())
            runtime.write_text(runtime.read_text() + '\n// unknown candidate bytes\n')
            with patch.object(gallery.subprocess, 'check_output') as execute:
                with self.assertRaisesRegex(ValueError, 'Unreviewed gallery runtime'):
                    gallery.update_example(staged, sample)
                execute.assert_not_called()
            # Candidate-provided metadata must not grant trust.
            (staged / 'trusted-runtime.json').write_text(json.dumps({
                'executableHashes': {'terminalStyle.ts': gallery.digest(runtime)}}))
            with self.assertRaisesRegex(ValueError, 'Unreviewed gallery runtime'):
                gallery.update_example(staged, sample)

    def test_refuses_moving_source_without_creating_output(self):
        output = self.root / 'must-not-exist'
        result = subprocess.run(['python3', str(TOOLS / 'run.py'), '--source', 'HEAD', '--output', str(output)], capture_output=True, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output.exists())

    def test_index_exposes_update_and_preserves_evidence_labels(self):
        with tempfile.TemporaryDirectory(prefix='ballin-index-test-') as temp:
            root = Path(temp)
            entries = []
            for identifier, kind in [('staged-update', 'staged'), ('recorded-update', 'actual-vm')]:
                folder = root / identifier
                folder.mkdir()
                (folder / 'output-001.png').touch()
                entries.append({'id': identifier, 'kind': kind, 'category': 'Update', 'title': identifier,
                                'edits': {'method': 'Redraw normalization.', 'omitted': ['Guard status', 'Inspector boilerplate']}})
            gallery.write_index(root, entries, 'a' * 40)
            text = (root / 'index.md').read_text()
            headings = [line for line in text.splitlines() if line.startswith('## ')]
            self.assertEqual(headings, ['## ' + category for category in gallery.CATEGORIES])
            for entry in entries:
                self.assertIn(entry['id'] + ' (' + entry['kind'] + ')', text)
                for name in ['preview.ansi', 'text.txt', 'output-001.png', 'provenance.json']:
                    self.assertIn('(' + entry['id'] + '/' + name + ')', text)
            self.assertIn('Normalization/omissions: Redraw normalization. Omitted: Guard status; Inspector boilerplate', text)


class GalleryBuildTests(unittest.TestCase):
    def run_checked(self, command):
        result = subprocess.run(command, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0,
                         f'{command!r}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}')
        return result

    def test_current_setup_copy_and_preserved_historical_replay(self):
        legacy = TOOLS.parent / 'pr-662-output-gallery'
        source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=TOOLS, text=True).strip()
        with tempfile.TemporaryDirectory(prefix='ballin-gallery-source-test-') as temp:
            current = Path(temp) / 'current'
            self.run_checked(['python3', str(legacy / 'build.py'), '--candidate', source,
                              '--output', str(current)])
            shutil.copy2(legacy / 'verify.py', current)
            self.run_checked(['python3', str(current / 'verify.py')])
            text = (current / 'plain.txt').read_text()
            self.assertIn('Enable Ballin tab completion in ~/.bash_profile? [y/N] Yes', text)
            self.assertIn('Enable Ballin tab completion in ~/.bash_profile? [y/N] No', text)
            self.assertNotIn('Startup file:', text)
            self.assertNotIn('Change preferences later with', text)
            self.assertNotIn('Change backup settings later with', text)
            self.assertIn('Change backup settings with', text)
            self.assertIn('Change preferences with', text)
            anchors = json.loads((current / 'source-anchors.json').read_text())
            self.assertIn("phase 'Initial configuration'", [a['anchor'] for a in anchors])
            historical = Path(temp) / 'historical'
            shutil.copytree(legacy, historical)
            self.run_checked(['python3', str(historical / 'verify.py')])
            self.assertIn('Change preferences later with', (historical / 'plain.txt').read_text())


class GallerySecurityTests(unittest.TestCase):
    def test_runtime_profiles_require_one_complete_reviewed_set(self):
        legacy = TOOLS.parent / 'pr-662-output-gallery'
        with tempfile.TemporaryDirectory(prefix='ballin-runtime-profile-') as temp:
            root = Path(temp)
            builder = root / 'build.py'
            shutil.copy2(legacy / 'build.py', builder)
            pins = root / 'generation-runtime.json'
            shutil.copy2(legacy / 'generation-runtime.json', pins)
            repo = TOOLS.parents[1]
            source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
            command = ['python3', str(builder), '--root', str(repo), '--candidate', source]
            # Select the complete reviewed profile matching this source, rather
            # than assuming HEAD still uses the historical top-level profile.
            baseline = root / 'baseline'
            subprocess.run(command + ['--output', str(baseline)], check=True, capture_output=True, timeout=30)
            original = json.loads((baseline / 'trusted-runtime.json').read_text())
            wrong = {**original, 'executableHashes': {**original['executableHashes'], 'terminalStyle.ts': '0' * 64}}
            pins.write_text(json.dumps({**wrong, 'reviewedProfiles': [original]}))
            output = root / 'accepted'
            subprocess.run(command + ['--output', str(output)], check=True, capture_output=True, timeout=30)
            self.assertEqual(json.loads((output / 'trusted-runtime.json').read_text()), original)
            partial = {**original, 'executableHashes': {**original['executableHashes'], 'help_format.ts': '0' * 64}}
            pins.write_text(json.dumps({**wrong, 'reviewedProfiles': [partial]}))
            result = subprocess.run(command + ['--output', str(root / 'rejected')], capture_output=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b'Unreviewed gallery runtime', result.stderr)
            self.assertFalse((root / 'rejected' / 'gallery.cjs').exists())

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
