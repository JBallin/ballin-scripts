#!/usr/bin/env python3
"""Offline site/bundle contracts. Fixtures contain no actual capture data."""
import contextlib
import copy
import io
import functools
import http.client
import threading
import json
from pathlib import Path
import stat
import struct
import subprocess
import tempfile
import unittest
from unittest import mock
import zipfile
import zlib

import importlib.util

# Avoid Python's standard-library site module name.
spec = importlib.util.spec_from_file_location('ballin_site', Path(__file__).with_name('site.py'))
site = importlib.util.module_from_spec(spec)
spec.loader.exec_module(site)
preview_spec = importlib.util.spec_from_file_location('ballin_preview', Path(__file__).with_name('preview.py'))
preview = importlib.util.module_from_spec(preview_spec)
preview_spec.loader.exec_module(preview)

local_spec = importlib.util.spec_from_file_location('ballin_local', Path(__file__).with_name('local.py'))
local = importlib.util.module_from_spec(local_spec)
local_spec.loader.exec_module(local)


def png():
    def chunk(name, data):
        return struct.pack('>I', len(data)) + name + data + struct.pack('>I', zlib.crc32(name + data))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(b'\0\x20\x30\x40')) + chunk(b'IEND', b''))


def fixture():
    text = 'STAGED — synthetic test fixture; no live execution.\n$ ballin update\n<untrusted & text>\n'.encode()
    entry = {'id': 'update', 'title': 'Synthetic update fixture', 'category': 'Update', 'kind': 'staged',
             'sourceRevision': 'a' * 40, 'edits': 'Synthetic fixture only.', 'text': 'gallery/update/text.txt',
             'images': ['gallery/update/output-001.png'], 'readmeUpdate': True}
    files = {entry['text']: text, entry['images'][0]: png()}
    manifest = {'schema': 1, 'entries': [entry], 'files': {name: {'size': len(data), 'sha256': site.digest(data)} for name, data in files.items()}}
    return manifest, files


def archive(manifest, files, extras=()):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as output:
        output.writestr('manifest.json', site.json_bytes(manifest))
        for name, data in list(files.items()) + list(extras):
            output.writestr(name, data)
    return buffer.getvalue()


def pin_for(data):
    return {'mode': 'release', 'release': {'id': 11, 'tag': 'v1.0.0', 'commit': 'a' * 40},
            'asset': {'id': 22, 'name': 'ballin-gallery-v1.0.0.zip', 'size': len(data), 'sha256': site.digest(data)}}


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.manifest, self.files = fixture()
        self.data = archive(self.manifest, self.files)
        self.pin = pin_for(self.data)

    def test_roundtrip(self):
        self.assertEqual(site.read_bundle(self.data, site.digest(self.data)), (self.manifest, self.files))

    def test_replace_preserves_complete_untouched_examples_and_order(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, files = copy.deepcopy(self.manifest), dict(self.files)
            retained = copy.deepcopy(manifest['entries'][0])
            retained.update(id='older', title='Older actual example', kind='actual-vm',
                            text='gallery/older/text.txt', images=['gallery/older/output-001.png'], readmeUpdate=False)
            manifest['entries'].insert(0, retained)
            for name, data in [(retained['text'], b'ACTUAL older source retained verbatim\n'), (retained['images'][0], png())]:
                files[name] = data
                manifest['files'][name] = {'size': len(data), 'sha256': site.digest(data)}
            base = archive(manifest, files)
            replacement, changed_files = copy.deepcopy(self.manifest), dict(self.files)
            replacement['entries'][0].update(sourceRevision='b' * 40, edits='Reviewed replacement; staged, not actual.')
            changed_files['gallery/update/text.txt'] = b'STAGED replacement; entire matching transcript\n'
            changed_files['gallery/update/output-002.png'] = png()
            replacement['entries'][0]['images'].append('gallery/update/output-002.png')
            replacement['files'] = {name: {'size': len(data), 'sha256': site.digest(data)} for name, data in changed_files.items()}
            update = archive(replacement, changed_files)
            pin = pin_for(base)
            (root / 'pin.json').write_bytes(site.json_bytes(pin))
            (root / 'base.zip').write_bytes(base)
            (root / 'replacement.zip').write_bytes(update)
            for index in range(2):
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    site.replace_examples(root / 'pin.json', root / 'base.zip', root / 'replacement.zip',
                                          site.digest(update), ['update'], root / f'candidate-{index}.zip')
                evidence = json.loads(out.getvalue())
                self.assertEqual(evidence['retained'], ['older'])
                self.assertEqual(evidence['baseSha256'], pin['asset']['sha256'])
            data = (root / 'candidate-0.zip').read_bytes()
            result, result_files = site.read_bundle(data, evidence['sha256'])
            self.assertEqual(result['entries'], [retained, replacement['entries'][0]])
            for name in [retained['text']] + retained['images']:
                self.assertEqual(result_files[name], files[name])
                self.assertEqual(result['files'][name], manifest['files'][name])
            for name, value in changed_files.items():
                self.assertEqual(result_files[name], value)
            self.assertEqual(data, (root / 'candidate-1.zip').read_bytes())
            self.assertEqual((root / 'base.zip').read_bytes(), base)
            self.assertEqual((root / 'pin.json').read_bytes(), site.json_bytes(pin))
            with self.assertRaisesRegex(ValueError, 'Output exists'):
                site.replace_examples(root / 'pin.json', root / 'base.zip', root / 'replacement.zip',
                                      site.digest(update), ['update'], root / 'candidate-0.zip')

    def test_replace_rejects_identity_changes_omissions_and_invalid_replacements(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def attempt(pin=None, base=None, replacement=None, sha=None, ids=None):
                (root / 'pin.json').write_bytes(site.json_bytes(self.pin if pin is None else pin))
                (root / 'base.zip').write_bytes(self.data if base is None else base)
                data = self.data if replacement is None else replacement
                (root / 'replacement.zip').write_bytes(data)
                with contextlib.redirect_stdout(io.StringIO()):
                    site.replace_examples(root / 'pin.json', root / 'base.zip', root / 'replacement.zip',
                                          site.digest(data) if sha is None else sha,
                                          ['update'] if ids is None else ids, root / 'candidate.zip')
            missing = copy.deepcopy(self.manifest)
            del missing['entries'][0]['sourceRevision']
            bad_files = dict(self.files)
            del bad_files['gallery/update/text.txt']
            unsafe = archive(self.manifest, self.files, [('../private.txt', b'unsafe')])
            undesignated = copy.deepcopy(self.manifest)
            undesignated['entries'][0]['readmeUpdate'] = False
            for case in [
                {'pin': {'mode': 'bootstrap', 'reason': 'No approved bundle'}},
                {'pin': {**self.pin, 'asset': {**self.pin['asset'], 'size': len(self.data) + 1}}},
                {'base': self.data + b'altered'},
                {'sha': 'f' * 64}, {'sha': 'main'},
                {'ids': ['update', 'update']}, {'ids': []}, {'ids': ['../update']},
                {'ids': ['missing']}, {'ids': ['update', 'missing']},
                {'replacement': archive(missing, self.files)},
                {'replacement': archive(self.manifest, bad_files)}, {'replacement': unsafe},
                {'replacement': archive(undesignated, self.files)},
            ]:
                with self.subTest(case=case), self.assertRaises((ValueError, KeyError)):
                    attempt(**case)
                self.assertFalse((root / 'candidate.zip').exists())
            # A valid replacement cannot add a new ID, even with an exact selection.
            changed = copy.deepcopy(self.manifest)
            changed['entries'][0].update(id='new', text='gallery/new/text.txt', images=['gallery/new/output-001.png'])
            changed_files = {name.replace('/update/', '/new/'): data for name, data in self.files.items()}
            changed['files'] = {name: {'size': len(data), 'sha256': site.digest(data)} for name, data in changed_files.items()}
            with self.assertRaisesRegex(ValueError, 'unknown entries'):
                attempt(replacement=archive(changed, changed_files), ids=['new'])
            # A second designated README Update in a partial replacement must not
            # conflict with a retained designation in the complete result.
            by_id = copy.deepcopy(changed)
            by_id['entries'][0]['readmeUpdate'] = False
            base_manifest = copy.deepcopy(self.manifest)
            base_manifest['entries'] += by_id['entries']
            base_files = {**self.files, **changed_files}
            base_manifest['files'].update(by_id['files'])
            base = archive(base_manifest, base_files)
            with self.assertRaisesRegex(ValueError, 'repeated Update'):
                attempt(pin=pin_for(base), base=base, replacement=archive(changed, changed_files), ids=['new'])

    def test_replace_downloads_pinned_base_when_no_offline_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'pin.json').write_bytes(site.json_bytes(self.pin))
            (root / 'replacement.zip').write_bytes(self.data)
            with mock.patch.object(site, 'retrieve', return_value=self.data) as retrieve, contextlib.redirect_stdout(io.StringIO()):
                site.replace_examples(root / 'pin.json', None, root / 'replacement.zip', site.digest(self.data), ['update'], root / 'candidate.zip')
            retrieve.assert_called_once_with(self.pin)
            self.assertEqual(site.read_bundle((root / 'candidate.zip').read_bytes()), (self.manifest, self.files))

    def test_replace_can_remove_old_continuation_page_and_transfer_readme_designation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base, files = copy.deepcopy(self.manifest), dict(self.files)
            extra = copy.deepcopy(base['entries'][0])
            extra.update(id='other', text='gallery/other/text.txt', images=['gallery/other/output-001.png'], readmeUpdate=False)
            base['entries'].append(extra)
            base['entries'][0]['images'].append('gallery/update/output-002.png')
            files.update({'gallery/update/output-002.png': png(), extra['text']: b'STAGED other complete transcript\n', extra['images'][0]: png()})
            base['files'] = {name: {'size': len(data), 'sha256': site.digest(data)} for name, data in files.items()}
            original = archive(base, files)
            replacements = copy.deepcopy(base)
            replacements['entries'][0]['readmeUpdate'] = False
            replacements['entries'][0]['images'].pop()
            replacements['entries'][1]['readmeUpdate'] = True
            del replacements['files']['gallery/update/output-002.png']
            replacements_files = {name: data for name, data in files.items() if name in replacements['files']}
            replacement = archive(replacements, replacements_files)
            (root / 'pin.json').write_bytes(site.json_bytes(pin_for(original)))
            (root / 'base.zip').write_bytes(original)
            (root / 'replacement.zip').write_bytes(replacement)
            with contextlib.redirect_stdout(io.StringIO()):
                site.replace_examples(root / 'pin.json', root / 'base.zip', root / 'replacement.zip', site.digest(replacement),
                                      ['update', 'other'], root / 'candidate.zip')
            manifest, result_files = site.read_bundle((root / 'candidate.zip').read_bytes())
            self.assertEqual(manifest, replacements)
            self.assertNotIn('gallery/update/output-002.png', result_files)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                site.readme_example(root / 'candidate.zip')
            self.assertIn('STAGED other complete transcript', out.getvalue())

    def test_bundle_and_file_hashes_fail_closed(self):
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            site.read_bundle(self.data, 'f' * 64)
        self.files['gallery/update/text.txt'] += b'altered'
        with self.assertRaisesRegex(ValueError, 'integrity'):
            site.read_bundle(archive(self.manifest, self.files))

    def test_private_or_surprising_files_are_refused(self):
        for name in ['raw.ansi', 'capture-input.json', 'gallery/update/environment.json', 'tools/render.swift']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                site.read_bundle(archive(self.manifest, self.files, [(name, b'PRIVATE SENTINEL')]))

    def test_unsafe_paths(self):
        for name in ['../escape', '/escape', 'gallery/../escape', 'gallery//text.txt', 'gallery\\escape', 'C:/escape', './manifest.json']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                site.read_bundle(archive(self.manifest, self.files, [(name, b'x')]))

    def test_symlinks_devices_directories_and_duplicates(self):
        for mode in [stat.S_IFLNK, stat.S_IFCHR, stat.S_IFDIR]:
            info = zipfile.ZipInfo('gallery/extra')
            info.external_attr = (mode | 0o644) << 16
            with self.subTest(mode=mode), self.assertRaisesRegex(ValueError, 'regular files'):
                site.read_bundle(archive(self.manifest, self.files, [(info, b'target')]))
        with self.assertWarns(UserWarning):
            data = archive(self.manifest, self.files, [('manifest.json', b'{}')])
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            site.read_bundle(data)

    def test_expansion_limits(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as output:
            output.writestr('manifest.json', b'x' * 1024 * 1024)
        with self.assertRaisesRegex(ValueError, 'compression ratio'):
            site.read_bundle(buffer.getvalue())
        with self.assertRaisesRegex(ValueError, 'compressed size'):
            site.read_bundle(b'x' * (site.MAX_ZIP + 1))

    def test_manifest_is_an_exact_public_schema(self):
        for value in ['capturesManifest', 'environment', 'command', 'answers', 'raw']:
            manifest = copy.deepcopy(self.manifest)
            manifest['entries'][0][value] = 'PRIVATE SENTINEL'
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'schema fields'):
                site.read_bundle(archive(manifest, self.files))
        with self.assertRaisesRegex(ValueError, 'Duplicate JSON'):
            site.load_json('{"schema":1,"schema":1}')

    def test_missing_images_and_bad_labels(self):
        for field, value in [('kind', 'live'), ('sourceRevision', 'main'), ('readmeUpdate', 1), ('category', 'Unknown'), ('images', [])]:
            manifest = copy.deepcopy(self.manifest)
            manifest['entries'][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                site.read_bundle(archive(manifest, self.files))

    def test_invalid_png_or_terminal_controls(self):
        for name, data in [('gallery/update/output-001.png', b'not a PNG'), ('gallery/update/text.txt', b'\x1b[31mANSI')]:
            files = dict(self.files, **{name: data})
            manifest = copy.deepcopy(self.manifest)
            manifest['files'][name] = {'size': len(data), 'sha256': site.digest(data)}
            with self.subTest(name=name), self.assertRaises(ValueError):
                site.read_bundle(archive(manifest, files))

    def test_png_requires_valid_complete_bounded_image_stream(self):
        image = png()
        for data in [image[:33], image[:-12], image + b'extra', image[:-15] + b'bad' + image[-12:]]:
            with self.subTest(data=data), self.assertRaises(ValueError):
                site.validate_png(data)
        # Header dimensions alone cannot permit an expanded image-data bomb.
        def chunk(name, data):
            return struct.pack('>I', len(data)) + name + data + struct.pack('>I', zlib.crc32(name + data))
        bad = image[:33] + chunk(b'IDAT', zlib.compress(b'x' * 1000000)) + image[-12:]
        with self.assertRaisesRegex(ValueError, 'size/stream'):
            site.validate_png(bad)

    def test_png_capture_metadata_removed_without_changing_pixels(self):
        metadata = b'PRIVATE SENTINEL'
        chunk = struct.pack('>I', len(metadata)) + b'eXIf' + metadata + struct.pack('>I', zlib.crc32(b'eXIf' + metadata))
        original = png()
        image = original[:33] + chunk + original[33:]
        self.assertEqual(site.public_png(image), original)
        with self.assertRaisesRegex(ValueError, 'Unexpected PNG'):
            site.validate_png(image)

    def test_nul_archive_filename_is_rejected_before_python_normalization(self):
        # ZIP supports arbitrary bytes; mutate both local and central names to
        # reproduce Python's NUL-truncating ZipInfo normalization.
        name = b'gallery/update/output-001.png'
        files = dict(self.files)
        files['gallery/update/output-001.pngX'] = files.pop('gallery/update/output-001.png')
        data = archive(self.manifest, files)
        data = data.replace(name + b'X', name + b'\0')
        with self.assertRaisesRegex(ValueError, 'Ambiguous archive filename'):
            site.read_bundle(data)

    def test_readme_image_title_cannot_inject_markdown(self):
        self.manifest['entries'][0]['title'] = 'Update ](https://example.invalid) ![injected " <tag>'
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory) / 'title.zip'
            bundle.write_bytes(archive(self.manifest, self.files))
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                site.readme_example(bundle, 'https://jballin.github.io/ballin-scripts')
            self.assertIn('<img src="https://jballin.github.io/ballin-scripts/gallery/update/output-001.png" alt="Staged demonstration: Update ]', out.getvalue())
            self.assertIn('&quot; &lt;tag&gt;', out.getvalue())
            self.assertLess(out.getvalue().index('<img '), out.getvalue().index('<details>'))
            self.assertIn('[`aaaaaaaaaaaa`](https://github.com/JBallin/ballin-scripts/tree/' + 'a' * 40 + ')', out.getvalue())

    def test_readme_disclosure_is_literal_markdown_and_html(self):
        self.manifest['entries'][0]['edits'] = 'Reviewed omission.\n\n[Injected link](https://example.invalid/) and ![tracking](https://example.invalid/image.png) <img src="https://example.invalid/html.png">'
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory) / 'disclosure.zip'
            bundle.write_bytes(archive(self.manifest, self.files))
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                site.readme_example(bundle)
            payload = {'pages': [{'path': 'README.md', 'text': out.getvalue()}], 'base': '', 'sourceBase': 'https://example.com/source'}
            content = json.loads(subprocess.check_output(['node', str(site.ROOT / 'tools/site/markdown.cjs')], input=site.json_bytes(payload)))[0]['content']
            self.assertIn('[Injected link](https://example.invalid/)', content)
            self.assertNotIn('<img ', content)
            self.assertNotIn('<a href="https://example.invalid', content)
            self.assertIn('&lt;img src=', content)

    def mock_api(self, mutation=None, annotated=False):
        release = {'id': 11, 'tag_name': 'v1.0.0', 'draft': False, 'prerelease': False, 'published_at': '2026-11-05', 'assets': [{'id': 22}]}
        asset = {**self.pin['asset'], 'state': 'uploaded', 'digest': 'sha256:' + site.digest(self.data)}
        tag = {'object': {'type': 'tag' if annotated else 'commit', 'sha': 'b' * 40 if annotated else 'a' * 40}}
        responses = {'/releases/11': release, '/releases/assets/22': asset, '/git/ref/tags/v1.0.0': tag,
                     '/git/tags/' + 'b' * 40: {'object': {'type': 'commit', 'sha': 'a' * 40}}}
        if mutation:
            mutation(responses)
        calls = []

        def request(path, binary=False):
            calls.append((path, binary))
            return self.data if binary else responses[path]
        return request, calls

    def test_exact_release_retrieval_including_annotated_tags(self):
        for annotated in [False, True]:
            request, calls = self.mock_api(annotated=annotated)
            self.assertEqual(site.retrieve(self.pin, request), self.data)
            self.assertEqual(calls[-1], ('/releases/assets/22', True))
            self.assertFalse(any('latest' in path for path, _ in calls))

    def test_release_or_asset_substitution_refused_before_download(self):
        mutations = [
            lambda r: r['/releases/11'].update(id=12),
            lambda r: r['/releases/11'].update(tag_name='v1.0.1'),
            lambda r: r['/releases/11'].update(draft=True),
            lambda r: r['/releases/11'].update(prerelease=True),
            lambda r: r['/releases/11'].update(assets=[]),
            lambda r: r['/git/ref/tags/v1.0.0']['object'].update(sha='c' * 40),
            lambda r: r['/releases/assets/22'].update(id=23),
            lambda r: r['/releases/assets/22'].update(name='changed.zip'),
            lambda r: r['/releases/assets/22'].update(size=1),
            lambda r: r['/releases/assets/22'].update(digest='sha256:' + 'f' * 64),
        ]
        for mutation in mutations:
            request, calls = self.mock_api(mutation)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                site.retrieve(self.pin, request)
            self.assertFalse(any(binary for _, binary in calls))

    def test_credentials_not_forwarded_on_storage_redirect(self):
        import urllib.request
        request = urllib.request.Request(site.API + '/releases/assets/22', headers={'Authorization': 'Bearer TEST SENTINEL'})
        redirected = site.SafeRedirect().redirect_request(request, None, 302, 'Found', {}, 'https://release-assets.githubusercontent.com/file')
        self.assertIsNone(redirected.get_header('Authorization'))
        with self.assertRaises(ValueError):
            site.SafeRedirect().redirect_request(request, None, 302, 'Found', {}, 'https://example.com/file')

    def test_pin_requires_explicit_mode_and_identity(self):
        for pin in [{}, {'mode': 'auto'}, {'mode': 'bootstrap'}, {**self.pin, 'asset': {**self.pin['asset'], 'id': True}}]:
            with self.subTest(pin=pin), self.assertRaises(ValueError):
                site.validate_pin(pin)

    def test_readme_uses_canonical_text_and_optional_same_images(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'bundle.zip'
            path.write_bytes(self.data)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                site.readme_example(path, 'https://jballin.github.io/ballin-scripts')
            value = out.getvalue()
            self.assertIn('gallery/update/output-001.png', value)
            self.assertIn('&lt;untrusted &amp; text&gt;', value)
            self.assertEqual(value.count('<details>'), 2)
            self.assertNotIn('<details open', value)

    def test_pack_is_minimal_deterministic_and_refuses_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gallery = root / 'input'
            folder = gallery / 'staged-09'
            folder.mkdir(parents=True)
            text = self.files['gallery/update/text.txt']
            report = site.json_bytes({'text': text.decode(), 'private': 'PRIVATE SENTINEL'})
            for name, data in [('text.txt', text), ('output-001.png', png()), ('output.json', report), ('raw.ansi', b'PRIVATE SENTINEL')]:
                (folder / name).write_bytes(data)
            scenario = {**self.manifest['entries'][0], 'id': 'staged-09', 'environment': 'PRIVATE SENTINEL',
                        'files': {p.name: site.digest(p.read_bytes()) for p in folder.iterdir()}}
            (gallery / 'manifest.json').write_bytes(site.json_bytes({'scenarios': [scenario], 'capturesManifest': 'PRIVATE SENTINEL'}))
            selected = {'schema': 1, 'entries': [{'scenario': 'staged-09', 'id': 'update', 'title': 'Synthetic update fixture', 'edits': 'Synthetic fixture only.', 'approvedForPublication': True, 'readmeUpdate': True}]}
            selection = root / 'selection.json'
            selection.write_bytes(site.json_bytes(selected))
            with contextlib.redirect_stdout(io.StringIO()):
                site.pack(gallery, selection, root / 'one.zip')
                site.pack(gallery, selection, root / 'two.zip')
            self.assertEqual((root / 'one.zip').read_bytes(), (root / 'two.zip').read_bytes())
            manifest, files = site.read_bundle((root / 'one.zip').read_bytes())
            self.assertEqual(set(files), set(self.files))
            self.assertNotIn('PRIVATE SENTINEL', json.dumps(manifest) + repr(files))
            with self.assertRaisesRegex(ValueError, 'Output exists'):
                site.pack(gallery, selection, root / 'one.zip')
            selected['entries'][0]['approvedForPublication'] = False
            selection.write_bytes(site.json_bytes(selected))
            with self.assertRaisesRegex(ValueError, 'approval'):
                site.pack(gallery, selection, root / 'refused.zip')
            selected['entries'][0]['approvedForPublication'] = True
            selection.write_bytes(site.json_bytes(selected))
            (folder / 'text.txt').write_text('altered')
            with self.assertRaisesRegex(ValueError, 'disagree'):
                site.pack(gallery, selection, root / 'mismatch.zip')


class BuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.folder = Path(cls.temp.name)
        cls.manifest, cls.files = fixture()
        cls.data = archive(cls.manifest, cls.files)
        cls.bundle = cls.folder / 'bundle.zip'
        cls.bundle.write_bytes(cls.data)
        cls.pin = cls.folder / 'pin.json'
        cls.pin.write_bytes(site.json_bytes(pin_for(cls.data)))
        cls.bootstrap_pin = cls.folder / 'bootstrap.json'
        cls.bootstrap_pin.write_bytes(site.json_bytes({'mode': 'bootstrap', 'reason': 'Synthetic fixture.'}))
        cls.output = cls.folder / 'complete'
        with contextlib.redirect_stdout(io.StringIO()):
            site.build(cls.output, cls.pin, '/ballin-scripts', cls.bundle)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_analytics_disabled_by_default_and_null_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'analytics.json'
            path.write_text(json.dumps({'token': None}))
            self.assertIsNone(site.analytics_config(path))
        for page in self.output.rglob('*.html'):
            self.assertNotIn('src="/ballin-scripts/analytics.js"', page.read_text())

    def test_analytics_configuration_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'analytics.json'
            for token in ('', 'not-a-token', 'A' * 32, '<script>', 12, False, []):
                path.write_text(json.dumps({'token': token}))
                with self.subTest(token=token), self.assertRaises(ValueError):
                    site.analytics_config(path)
            for config in ({}, {'token': None, 'secret': 'no'}):
                path.write_text(json.dumps(config))
                with self.assertRaises(ValueError):
                    site.analytics_config(path)
            path.write_text(json.dumps({'token': 'a' * 32}))
            self.assertEqual(site.analytics_config(path), 'a' * 32)

    def test_analytics_enabled_on_every_page_in_both_hosting_modes(self):
        for index, base in enumerate(('', '/ballin-scripts')):
            output = self.folder / f'analytics-{index}'
            with contextlib.redirect_stdout(io.StringIO()):
                site.build(output, self.pin, base, self.bundle, 'https://getballin.com', 'a' * 32)
            for page in output.rglob('*.html'):
                self.assertEqual(page.read_text().count(f'src="{base}/analytics.js"'), 1)
                self.assertIn('data-origin="https://getballin.com"', page.read_text())
                self.assertIn('data-token="' + 'a' * 32 + '"', page.read_text())
            self.assertTrue((output / 'analytics.js').is_file())
            site.verify_site(output, base)

    def test_analytics_loader_offline_origin_and_token_guards(self):
        subprocess.run(['node', str(site.ROOT / 'tools/site/test_analytics.cjs')], check=True)

    def test_netlify_credit_in_shared_footer(self):
        credit = '<a href="https://www.netlify.com/">This site is powered by Netlify</a>'
        for page in self.output.rglob('*.html'):
            source = page.read_text()
            footer = source.split('<footer>', 1)[1].split('</footer>', 1)[0]
            self.assertEqual(footer.count(credit), 1)
            self.assertIn('View source on GitHub', footer)
            self.assertIn('Back up dotfiles. Keep your tools current.', footer)

    def test_complete_site_contains_docs_and_same_bundle_bytes(self):
        self.assertTrue((self.output / 'docs/installation.html').is_file())
        self.assertTrue((self.output / 'sitemap.xml').is_file())
        for name, data in self.files.items():
            self.assertEqual((self.output / name).read_bytes(), data)
        source = (self.output / 'index.html').read_text()
        self.assertIn('/ballin-scripts/docs/quickstart.html', source)
        self.assertIn('/ballin-scripts/gallery.html', source)
        self.assertIn('github.com/JBallin/ballin-scripts/blob/', source)
        site.verify_site(self.output, '/ballin-scripts')

    def test_community_guides_keep_public_urls_and_source_links(self):
        root_output = self.folder / 'community-root'
        with contextlib.redirect_stdout(io.StringIO()):
            site.build(root_output, self.bootstrap_pin, '', origin='https://getballin.com')
        revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=site.ROOT, text=True).strip()
        for output, origin, base in [(self.output, 'https://jballin.github.io', '/ballin-scripts'),
                                     (root_output, 'https://getballin.com', '')]:
            with self.subTest(base=base):
                sitemap = (output / 'sitemap.xml').read_text()
                for name in ['CONTRIBUTING', 'SUPPORT', 'SECURITY']:
                    page = (output / (name + '.html')).read_text()
                    self.assertIn(f'<loc>{origin}{base}/{name}.html</loc>', sitemap)
                    self.assertIn(f'href="https://github.com/{site.REPO}/blob/{revision}/.github/{name}.md"', page)
                    self.assertFalse((output / '.github' / (name + '.html')).exists())
                contributing = (output / 'CONTRIBUTING.html').read_text()
                support = (output / 'SUPPORT.html').read_text()
                self.assertIn(f'href="{base}/index.html#installation"', contributing)
                self.assertIn(f'href="{base}/docs/index.html"', contributing)
                self.assertIn(f'href="{base}/docs/installation.html#selecting-a-revision"', contributing)
                self.assertIn(f'href="{base}/SUPPORT.html"', contributing)
                self.assertIn(f'href="{base}/docs/installation.html#health-and-recovery"', support)
                self.assertIn(f'href="{base}/SECURITY.html"', support)
                self.assertIn(f'/blob/{revision}/AGENTS.md', contributing)
                site.verify_site(output, base)

    def test_favicon_copy_download_and_full_resolution_pages(self):
        page = (self.output / 'gallery.html').read_text()
        self.assertIn('href="/ballin-scripts/favicon.svg"', page)
        self.assertIn('data-copy="text-update"', page)
        self.assertIn('role="status"', page)
        self.assertIn('download href="/ballin-scripts/gallery/update/text.txt"', page)
        self.assertIn('href="/ballin-scripts/gallery/update/output-001.html"', page)
        viewer = (self.output / 'gallery/update/output-001.html').read_text()
        self.assertIn('width="1" height="1"', viewer)
        self.assertNotIn('class="native-mode"', viewer)
        self.assertEqual(viewer.count('class="image-preview"'), 1)
        self.assertIn('/ballin-scripts/gallery.html#entry-update', viewer)
        self.assertIn('&lt;untrusted &amp; text&gt;', viewer)
        self.assertEqual((self.output / 'favicon.svg').read_bytes(), (site.ROOT / 'site/favicon.svg').read_bytes())

    def test_titles_and_static_share_metadata(self):
        from html.parser import HTMLParser
        class Head(HTMLParser):
            def __init__(self):
                super().__init__()
                self.meta = {}
            def handle_starttag(self, tag, attrs):
                attrs = dict(attrs)
                if tag == 'meta':
                    self.meta[attrs.get('property', attrs.get('name'))] = attrs.get('content')
        expected = {'index.html': 'Ballin — Back up dotfiles and update your Mac', 'LICENSE.html': 'LICENSE · Ballin', 'gallery.html': 'Output gallery · Ballin',
                    'gallery/update/output-001.html': 'Synthetic update fixture — page 1 of 1 · Ballin'}
        for path in self.output.rglob('*.html'):
            source = path.read_text()
            title = __import__('re').search(r'<title>(.*?)</title>', source).group(1)
            self.assertTrue(title.strip())
            self.assertNotEqual('Ballin · Ballin', title)
            if path.relative_to(self.output).as_posix() in expected:
                self.assertEqual(title, expected[path.relative_to(self.output).as_posix()])
            head = Head()
            head.feed(source)
            self.assertEqual(head.meta['og:title'], __import__('html').unescape(title))
            self.assertEqual(head.meta['twitter:title'], __import__('html').unescape(title))
            if path.relative_to(self.output).as_posix() == 'index.html':
                description = 'Back up your dotfiles and keep your macOS development tools current.'
                for key in ('description', 'og:description', 'twitter:description'):
                    self.assertEqual(head.meta[key], description)
            self.assertEqual(head.meta['twitter:card'], 'summary_large_image')
            self.assertEqual(head.meta['og:url'], 'https://jballin.github.io/ballin-scripts/' + path.relative_to(self.output).as_posix())
            self.assertEqual(head.meta['og:image'], 'https://jballin.github.io/ballin-scripts/docs/assets/brand/social-preview.png')
            self.assertEqual(head.meta['og:image:type'], 'image/png')
            self.assertTrue(head.meta['og:image:alt'])
        image = (self.output / 'docs/assets/brand/social-preview.png').read_bytes()
        self.assertEqual(image[:8], b'\x89PNG\r\n\x1a\n')
        self.assertEqual(struct.unpack('>II', image[16:24]), (1280, 640))
        self.assertEqual(image, (site.ROOT / 'docs/assets/brand/social-preview.png').read_bytes())

    def test_metadata_escaping_empty_titles_and_multi_page_titles(self):
        values = site.page_metadata({'path': 'docs/a & b.html', 'title': 'A "quote" <tag> & topic'}, '/project', 'https://example.com')
        self.assertEqual(values['pageTitle'], 'A &quot;quote&quot; &lt;tag&gt; &amp; topic · Ballin')
        self.assertEqual(values['canonical'], 'https://example.com/project/docs/a%20%26%20b.html')
        with self.assertRaises(ValueError):
            site.page_metadata({'path': 'empty.html', 'title': '  '}, '', 'https://example.com')
        manifest, files = fixture()
        manifest['entries'][0]['images'].append('gallery/update/output-002.png')
        files['gallery/update/output-002.png'] = png()
        pages = site.image_pages(manifest, files, '/ballin-scripts')
        self.assertEqual([page['title'] for page in pages], ['Synthetic update fixture — page 1 of 2', 'Synthetic update fixture — page 2 of 2'])
        for index, page in enumerate(pages, 1):
            self.assertIn(f'<span aria-current="page">Page {index}</span>', page['content'])
            other = 3 - index
            self.assertIn(f'href="/ballin-scripts/gallery/update/output-{other:03}.html">Page {other}</a>', page['content'])
            self.assertEqual(page['content'].count('class="image-pages"'), 2)
        self.assertEqual(site.image_page_navigation(fixture()[0]['entries'][0], 1, ''), '')

    def test_root_custom_domain_complete_snapshot_and_project_cli_override(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            custom = root / 'custom'
            subprocess.run(['python3', str(site.ROOT / 'tools/site/site.py'), 'build', '--output', str(custom),
                            '--pin', str(self.pin), '--bundle', str(self.bundle)], check=True, capture_output=True)
            project = root / 'project'
            subprocess.run(['python3', str(site.ROOT / 'tools/site/site.py'), 'build', '--output', str(project),
                            '--origin', 'https://jballin.github.io', '--base', '/ballin-scripts',
                            '--pin', str(self.pin), '--bundle', str(self.bundle)], check=True, capture_output=True)
            for output, origin, base in [(custom, 'https://getballin.com', ''), (project, 'https://jballin.github.io', '/ballin-scripts')]:
                metadata = json.loads((output / 'build.json').read_text())
                self.assertEqual(metadata['hosting'], {'origin': origin, 'base': base})
                site.verify_site(output, base)
                for relative in ['index.html', 'docs/quickstart.html', 'gallery.html', 'gallery/update/output-001.html']:
                    page = (output / relative).read_text()
                    self.assertIn('href="' + origin + base + '/' + relative + '"', page)
                    self.assertIn('content="' + origin + base + '/docs/assets/brand/social-preview.png"', page)
                    self.assertEqual(preview.selected_file(output, base, base + '/' + relative), (output / relative).resolve())
                self.assertIn(origin + base + '/gallery.html', (output / 'sitemap.xml').read_text())
                self.assertIn(origin + base + '/sitemap.xml', (output / 'robots.txt').read_text())
                self.assertFalse((output / 'CNAME').exists())
                for name, data in self.files.items():
                    self.assertEqual((output / name).read_bytes(), data)
                self.assertIn('github.com/JBallin/ballin-scripts/blob/', (output / 'gallery.html').read_text())

    def test_deployment_configuration_refuses_invalid_inputs(self):
        self.assertEqual(site.deployment_config(site.ROOT / 'site/deployment.json'), {'origin': 'https://getballin.com', 'base': ''})
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'deployment.json'
            for value in [{'origin': 'https://getballin.com', 'base': '/', 'extra': True},
                          {'origin': 'http://getballin.com', 'base': ''},
                          {'origin': 'https://getballin.com/path', 'base': ''},
                          {'origin': 'https://getballin.com', 'base': '/unsafe/..'},
                          {'origin': 'https://getballin.com', 'base': None}]:
                config.write_bytes(site.json_bytes(value))
                with self.assertRaises(ValueError):
                    site.deployment_config(config)

    def test_output_readability_and_provenance_disclosures(self):
        gallery = (self.output / 'gallery.html').read_text()
        viewer = (self.output / 'gallery/update/output-001.html').read_text()
        self.assertIn('<details class="provenance"><summary>Source and capture details</summary>', gallery)
        self.assertIn('<details class="provenance"><summary>Source and capture details</summary>', viewer)
        self.assertIn('href="/ballin-scripts/gallery/update/output-001.png">Open original PNG</a>', viewer)
        self.assertIn('Open the original PNG to zoom.', viewer)
        self.assertIn('Complete image, fitted to the page.', viewer)
        self.assertNotIn('Native resolution', viewer)
        self.assertIn('Synthetic fixture only.', gallery)
        self.assertIn('Synthetic fixture only.', viewer)
        self.assertIn('Copy text', viewer)
        self.assertIn('Download text', viewer)

    def test_gallery_orientation_precedes_examples_and_preserves_shared_width(self):
        gallery = (self.output / 'gallery.html').read_text()
        self.assertLess(gallery.index('Choose a topic'), gallery.index('<article'))
        for label in ['Installing', 'Backups &amp; preferences', 'Updating', 'Diagnostics']:
            self.assertIn(label, gallery)
        self.assertIn('How to read this gallery', gallery)
        style = (self.output / 'style.css').read_text()
        self.assertNotIn('max-width:1440px', style)
        self.assertNotIn('.full-image', style)

    def test_intro_gallery_link_keeps_readme_and_respects_bootstrap(self):
        complete = (self.output / 'docs/what-is-ballin.html').read_text()
        self.assertIn('class="gallery-related"', complete)
        self.assertIn('href="/ballin-scripts/gallery.html">Browse the output gallery</a>', complete)
        self.assertIn('href="/ballin-scripts/index.html#example-output"', complete)
        self.assertEqual(site.related_gallery('docs/what-is-ballin.md', '', False), '')
        self.assertEqual(site.related_gallery('docs/quickstart.md', '', True), '')
        self.assertIn('href="/gallery.html"', site.related_gallery('docs/what-is-ballin.md', '', True))

    def test_copy_success_failure_and_repeat_activation(self):
        subprocess.run(['node', str(site.ROOT / 'tools/site/test_interactions.cjs')], check=True)

    def test_preview_selects_only_one_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            selected = parent / 'chosen'
            selected.mkdir()
            (selected / 'index.html').write_text('public')
            (parent / 'private.txt').write_text('private')
            (selected / 'escape').symlink_to(parent / 'private.txt')
            (selected / 'nested').mkdir()
            (selected / 'nested/index.html').symlink_to(parent / 'private.txt')
            self.assertEqual(preview.selected_file(selected, '/ballin-scripts', '/ballin-scripts/index.html'), (selected / 'index.html').resolve())
            for path in ['/private.txt', '/ballin-scripts/../private.txt', '/ballin-scripts/%2e%2e/private.txt', '/ballin-scripts/escape', '/ballin-scripts/nested/']:
                with self.subTest(path=path):
                    self.assertIsNone(preview.selected_file(selected, '/ballin-scripts', path))

    def test_local_rebuild_switches_running_preview_only_after_success(self):
        with tempfile.TemporaryDirectory() as directory:
            storage = Path(directory) / 'local'
            version = ['first']
            def fake_build(output, *args, **kwargs):
                output.mkdir()
                (output / 'index.html').write_text(version[0])
                (output / 'build.json').write_text('{"hosting":{"base":""}}')
            with mock.patch.object(local.site, 'build', side_effect=fake_build):
                current = local.rebuild(storage)
                first = current.resolve()
                server = preview.http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(preview.Preview, site=current, base=''))
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                def fetch():
                    connection = http.client.HTTPConnection(*server.server_address, timeout=5)
                    try:
                        connection.request('GET', '/')
                        response = connection.getresponse()
                        self.assertEqual(response.status, 200)
                        self.assertEqual(response.getheader('Cache-Control'), 'no-store')
                        return response.read()
                    finally:
                        connection.close()
                try:
                    self.assertEqual(fetch(), b'first')
                    version[0] = 'second'
                    local.rebuild(storage)
                    self.assertEqual(fetch(), b'second')
                    self.assertNotEqual(first, current.resolve())
                    self.assertTrue(first.is_dir())
                    with mock.patch.object(local.site, 'build', side_effect=ValueError('failed validation')):
                        with self.assertRaisesRegex(ValueError, 'failed validation'):
                            local.rebuild(storage)
                    self.assertEqual(fetch(), b'second')
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=5)

    def test_local_rebuild_refuses_unmanaged_output_and_storage(self):
        with tempfile.TemporaryDirectory() as directory:
            storage = Path(directory) / 'local'
            storage.mkdir()
            current = storage / 'current'
            current.mkdir()
            (current / 'keep.txt').write_text('evidence')
            with self.assertRaisesRegex(ValueError, 'existing local preview'):
                local.rebuild(storage)
            self.assertEqual((current / 'keep.txt').read_text(), 'evidence')
            alias = Path(directory) / 'alias'
            alias.symlink_to(storage)
            with self.assertRaisesRegex(ValueError, 'must not be a symlink'):
                local.rebuild(alias)

    def test_local_rebuild_rejects_parallel_build_and_unmanaged_link(self):
        import fcntl
        with tempfile.TemporaryDirectory() as directory:
            storage = Path(directory) / 'local'
            storage.mkdir()
            with (storage / 'build.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaisesRegex(ValueError, 'Another local rebuild'):
                    local.rebuild(storage)
            target = Path(directory) / 'unmanaged'
            target.mkdir()
            (target / 'build.json').write_text('{}')
            (storage / 'current').symlink_to(target)
            with self.assertRaisesRegex(ValueError, 'unmanaged local preview link'):
                local.rebuild(storage)
            self.assertTrue((target / 'build.json').is_file())

    def test_preview_preserves_clean_directory_urls(self):
        with tempfile.TemporaryDirectory() as directory:
            selected = Path(directory)
            (selected / 'index.html').write_text('public home')
            for base in ['', '/ballin-scripts']:
                handler = functools.partial(preview.Preview, site=selected, base=base)
                server = preview.http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    for method in ['GET', 'HEAD']:
                        for path in [base + '/', base + '/index.html', base + '/?review=1']:
                            with self.subTest(base=base, method=method, path=path):
                                connection = http.client.HTTPConnection(*server.server_address, timeout=5)
                                try:
                                    connection.request(method, path)
                                    response = connection.getresponse()
                                    self.assertEqual(response.status, 200)
                                    self.assertIsNone(response.getheader('Location'))
                                    self.assertEqual(response.read(), b'public home' if method == 'GET' else b'')
                                finally:
                                    connection.close()
                    if base:
                        for path in ['/', base]:
                            connection = http.client.HTTPConnection(*server.server_address, timeout=5)
                            try:
                                connection.request('GET', path)
                                response = connection.getresponse()
                                self.assertEqual(response.status, 302)
                                self.assertEqual(response.getheader('Location'), base + '/')
                                response.read()
                            finally:
                                connection.close()
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=5)

    def test_preview_handles_only_disconnected_response_writes(self):
        class FailedWriter:
            def __init__(self, error):
                self.error = error
            def write(self, data):
                raise self.error
        for error in [BrokenPipeError('closed pipe'), ConnectionResetError('reset peer')]:
            with self.subTest(error=type(error).__name__):
                handler = object.__new__(preview.Preview)
                handler.close_connection = False
                messages = []
                handler.log_message = lambda message: messages.append(message)
                handler.copyfile(io.BytesIO(b'complete HTML'), FailedWriter(error))
                self.assertTrue(handler.close_connection)
                self.assertEqual(messages, ['Client disconnected while sending response body'])
        for error in [OSError(5, 'unexpected I/O failure'), TimeoutError('unexpected timeout')]:
            handler = object.__new__(preview.Preview)
            handler.log_message = lambda message: self.fail('Unexpected errors must propagate')
            with self.subTest(error=type(error).__name__), self.assertRaises(type(error)):
                handler.copyfile(io.BytesIO(b'HTML'), FailedWriter(error))

    def test_preview_normal_body_copy_is_unchanged(self):
        handler = object.__new__(preview.Preview)
        handler.close_connection = False
        handler.log_message = lambda message: self.fail('Normal transfer must not log a disconnect')
        output = io.BytesIO()
        data = b'<html>complete response</html>\x00binary'
        handler.copyfile(io.BytesIO(data), output)
        self.assertEqual(output.getvalue(), data)
        self.assertFalse(handler.close_connection)

    def test_heading_number_suffix_collisions_reserve_every_emitted_id(self):
        payload = {'pages': [{'path': 'README.md', 'text': '# Heading\n\n## Setup\n\n## Setup\n\n## Setup-1\n\n## Setup\n\n## Setup-1\n'}], 'base': '/ballin-scripts', 'sourceBase': 'https://example.com/source'}
        page = json.loads(subprocess.check_output(['node', str(site.ROOT / 'tools/site/markdown.cjs')], input=site.json_bytes(payload)))[0]
        ids = __import__('re').findall('id="([^"]+)"', page['content'])
        self.assertEqual(ids, ['heading', 'setup', 'setup-1', 'setup-1-1', 'setup-2', 'setup-1-2'])

    def test_readme_and_index_cannot_overwrite_the_same_output(self):
        payload = {'pages': [{'path': 'docs/README.md', 'text': '# Canonical index'}, {'path': 'docs/index.md', 'text': '# Colliding index'}], 'base': '/ballin-scripts', 'sourceBase': 'https://example.com/source'}
        result = subprocess.run(['node', str(site.ROOT / 'tools/site/markdown.cjs')], input=site.json_bytes(payload), capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'Duplicate site output path: docs/index.html', result.stderr)
        self.assertEqual(result.stdout, b'')

    def test_relative_url_contract_preserves_encoded_filename_delimiters(self):
        payload = {'pages': [{'path': 'docs/intro.md', 'text': '# Intro\n\n[Hash](a%23b.md)\n\n[Source](../tools/a%23b.py)'}, {'path': 'docs/a#b.md', 'text': '# Hash'}], 'base': '/ballin-scripts', 'sourceBase': 'https://example.com/source'}
        page = json.loads(subprocess.check_output(['node', str(site.ROOT / 'tools/site/markdown.cjs')], input=site.json_bytes(payload)))[0]
        self.assertIn('href="/ballin-scripts/docs/a%23b.html"', page['content'])
        self.assertIn('href="https://example.com/source/tools/a%23b.py"', page['content'])
        for link in ['/README.md', 'a%2Fb.md']:
            payload['pages'][0]['text'] = '# Intro\n\n[Unsupported](' + link + ')'
            result = subprocess.run(['node', str(site.ROOT / 'tools/site/markdown.cjs')], input=site.json_bytes(payload), capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b'Error:', result.stderr)

    def test_accessible_nested_details_and_escaped_text(self):
        value = (self.output / 'gallery.html').read_text()
        self.assertEqual(value.count('<details'), 4)
        self.assertNotIn('<details open', value)
        self.assertIn('<summary>Text version</summary>', value)
        self.assertIn('&lt;untrusted &amp; text&gt;', value)
        for anchor in ['install-quickstart', 'setup-backup', 'update', 'diagnostics']:
            self.assertIn('id="' + anchor + '"', value)

    def test_explicit_bootstrap_has_no_gallery_links(self):
        output = self.folder / 'bootstrap'
        with contextlib.redirect_stdout(io.StringIO()):
            site.build(output, self.bootstrap_pin, '/ballin-scripts')
        self.assertFalse((output / 'gallery.html').exists())
        self.assertNotIn('href="/ballin-scripts/gallery.html"', (output / 'index.html').read_text())
        with self.assertRaisesRegex(ValueError, 'Bootstrap'):
            site.build(self.folder / 'invalid-bootstrap', self.bootstrap_pin, '', self.bundle)

    def test_canonical_markdown_nested_details_tables_links_and_github_fragments(self):
        text = '# Fixture\n\n> [!TIP]\n> A useful tip.\n\n## Repeated `heading`\n\n## Repeated `heading`\n\n[Source](commands/update.ts)\n\n<details>\n<summary>Example installation</summary>\n\n![Fixture](docs/assets/brand/readme-hero.png)\n\n<details>\n<summary>Text version</summary>\n\n```text\n$ ballin update\n```\n\n</details>\n\n</details>\n\n| Command | Purpose |\n| --- | --- |\n| update | maintenance |\n'
        text = text.replace('A useful tip.', 'A useful [Quickstart](docs/quickstart.md) tip.')
        payload = {'pages': [{'path': 'README.md', 'text': text}, {'path': 'docs/quickstart.md', 'text': '# Quickstart'}], 'base': '/ballin-scripts', 'sourceBase': 'https://github.com/' + site.REPO + '/blob/' + 'a' * 40}
        pages = json.loads(subprocess.check_output(['node', str(site.ROOT / 'tools/site/markdown.cjs')], input=site.json_bytes(payload)))
        rendered = pages[0]['content']
        self.assertEqual(rendered.count('<details>'), 2)
        self.assertNotIn('<details open', rendered)
        self.assertIn('<pre><code class="language-text">$ ballin update', rendered)
        self.assertIn('<table>', rendered)
        self.assertIn('id="repeated-heading-1"', rendered)
        self.assertIn('/ballin-scripts/docs/assets/brand/readme-hero.png', rendered)
        self.assertIn('/blob/' + 'a' * 40 + '/commands/update.ts', rendered)
        self.assertNotIn('[!TIP]', rendered)
        self.assertIn('href="/ballin-scripts/docs/quickstart.html"', rendered)

    def test_invalid_pin_or_bundle_cannot_replace_good_snapshot(self):
        before = (self.output / 'index.html').read_bytes()
        with self.assertRaisesRegex(ValueError, 'Output exists'):
            site.build(self.output, self.pin, '/ballin-scripts', self.bundle)
        bad = self.folder / 'missing.zip'
        with self.assertRaises(ValueError):
            site.build(self.folder / 'bad-pin', self.pin, '/ballin-scripts', bad)
        self.assertEqual(before, (self.output / 'index.html').read_bytes())
        self.assertFalse((self.folder / 'bad-pin').exists())

    def test_verify_rejects_broken_fragments_and_base_paths(self):
        for value in ['<a href="/docs/installation.html">bad base</a>', '<a href="#missing">bad fragment</a>', '<img src="missing.png" alt="Fixture">']:
            with tempfile.TemporaryDirectory() as folder:
                output = Path(folder)
                (output / 'index.html').write_text(value)
                with self.subTest(value=value), self.assertRaises(ValueError):
                    site.verify_site(output, '/ballin-scripts')

    def test_workflow_scope_permissions_and_freshness(self):
        code = "const fs=require('node:fs'),yaml=require('js-yaml');process.stdout.write(JSON.stringify(yaml.load(fs.readFileSync('.github/workflows/pages.yml','utf8'))));"
        workflow = json.loads(subprocess.check_output(['node', '-e', code], cwd=site.ROOT))
        self.assertEqual(set(workflow['on']), {'push', 'workflow_dispatch'})
        self.assertEqual(workflow['on']['push']['branches'], ['main'])
        paths = set(workflow['on']['push']['paths'])
        expected = {'README.md', '.github/CONTRIBUTING.md', '.github/SUPPORT.md', '.github/SECURITY.md', 'LICENSE.md', 'docs/**', 'site/**', 'tools/site/**', '.nvmrc', '.github/workflows/pages.yml'}
        self.assertEqual(paths, expected)
        self.assertEqual(workflow['permissions'], {'contents': 'read'})
        self.assertFalse(workflow['concurrency']['cancel-in-progress'])
        build, deploy = workflow['jobs']['build'], workflow['jobs']['deploy']
        self.assertIn("github.ref == 'refs/heads/main'", build['if'])
        self.assertNotIn('permissions', build)
        self.assertEqual(deploy['permissions'], {'contents': 'read', 'pages': 'write', 'id-token': 'write'})
        self.assertEqual(deploy['needs'], 'build')
        self.assertEqual(build['steps'][0]['with']['ref'], 'main')
        freshness = next(step['run'] for step in deploy['steps'] if step.get('name') == 'Refuse a superseded snapshot')
        self.assertIn('git diff --exit-code', freshness)
        self.assertIn('docs site tools/site .nvmrc .github/workflows/pages.yml', freshness)
        for name in ['CONTRIBUTING.md', 'SUPPORT.md', 'SECURITY.md']:
            self.assertIn('.github/' + name, freshness.split())
            self.assertNotIn(name, freshness.split())


if __name__ == '__main__':
    unittest.main(verbosity=2)
