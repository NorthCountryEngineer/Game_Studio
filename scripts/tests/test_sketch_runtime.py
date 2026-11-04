"""Offline native archive guards using synthetic wheel ZIPs, never installs."""
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import importlib.util
import io
import inspect
import json
from pathlib import Path
import stat
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from zipfile import ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import sketch_runtime as runtime


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result


prepare = module('test_prepare_sketch_runtime', ROOT / 'scripts/prepare-sketch-runtime.py')
packager = module('test_package_sketch_runtime', ROOT / 'scripts/package-api.py')


class SketchRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='sketch-runtime-test-'); self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name).resolve()

    def wheels(self, first=None, second=None):
        records = []
        for name, entries in [('numpy', first if first is not None else [('numpy/__init__.py', b'synthetic numpy')]),
                ('pillow', second if second is not None else [('PIL/__init__.py', b'synthetic pillow')])]:
            path = self.directory / (name + '.whl')
            with ZipFile(path, 'w') as archive:
                for filename, data in entries:
                    info = filename if isinstance(filename, ZipInfo) else ZipInfo(filename)
                    archive.writestr(info, data)
            data = path.read_bytes()
            records.append({'name': name, 'version': '0', 'filename': path.name,
                'size': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                'url': 'https://files.pythonhosted.org/packages/synthetic/' + path.name})
        return records

    def members(self, records):
        with patch.object(runtime, 'locked_wheels', return_value=records):
            return list(runtime.wheel_files(self.directory))

    def fixture_source(self):
        root = self.directory / 'source'
        backend, config = root / 'backend/nce_api', root / 'config'
        backend.mkdir(parents=True); config.mkdir()
        for name, data in {'handler.py': b'reviewed handler', 'party.py': b'reviewed party',
                'multiplayer.py': b'reviewed relay', 'sketch_vision.py': b'main-only optional native module',
                'agent-framework.json': b'{}'}.items():
            (backend / name).write_bytes(data)
        (config / 'agent-framework.json').write_bytes(b'{}')
        (config / 'party-games.json').write_bytes(b'{}')
        models = backend / 'models/doodlenet'; models.mkdir(parents=True)
        (models / 'weights.bin').write_bytes(b'not executable model data')
        (models / 'classes.txt').write_bytes(b'cat\n')
        return root

    def test_all_wheel_hashes_are_verified_before_the_first_member_is_yielded(self):
        records = self.wheels()
        with (self.directory / records[1]['filename']).open('ab') as stream: stream.write(b'tampered')
        with patch.object(runtime, 'locked_wheels', return_value=records):
            iterator = runtime.wheel_files(self.directory)
            with self.assertRaisesRegex(ValueError, 'integrity'): next(iterator)

    def test_untrusted_roots_pth_and_generated_bytecode_cannot_shadow_the_application(self):
        records = self.wheels(first=[('handler.py', b'foreign handler'), ('sitecustomize.py', b'foreign initialization'),
            ('anything.pth', b'foreign startup'), ('numpy/__init__.py', b'allowed'),
            ('numpy/__pycache__/x.pyc', b'bytecode'), ('numpy/x.pyc', b'bytecode')])
        names = [name for name, data, native in self.members(records)]
        self.assertEqual(names, ['numpy/__init__.py', 'PIL/__init__.py'])

    def test_traversal_absolute_backslash_and_noncanonical_members_are_rejected(self):
        for name in ('../handler.py', '/handler.py', 'numpy/../../handler.py', 'numpy\\x.py',
                'numpy//x.py', 'numpy/./x.py'):
            with self.subTest(name=name):
                records = self.wheels(first=[(name, b'unsafe')])
                with self.assertRaisesRegex(ValueError, 'Unsafe'): self.members(records)

    def test_symlink_member_and_symlink_wheel_are_rejected(self):
        info = ZipInfo('numpy/linked.py'); info.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaisesRegex(ValueError, 'Unsafe'): self.members(self.wheels(first=[(info, b'../../handler.py')]))
        records = self.wheels(); path = self.directory / records[0]['filename']
        moved = self.directory / 'real-wheel.whl'; path.rename(moved); path.symlink_to(moved)
        with self.assertRaisesRegex(ValueError, 'Prepare pinned'): self.members(records)

    def test_duplicate_members_across_wheels_are_rejected(self):
        records = self.wheels(first=[('numpy/duplicate.py', b'one')], second=[('numpy/duplicate.py', b'two')])
        with self.assertRaisesRegex(ValueError, 'Duplicate'): self.members(records)

    def test_only_native_members_get_executable_archive_permissions(self):
        records = self.wheels(first=[('numpy/module.so', b'synthetic native'), ('numpy/text.py', b'python')],
            second=[('pillow.libs/libexample.so.1', b'synthetic library')])
        self.assertEqual({name: native for name, data, native in self.members(records)},
            {'numpy/module.so': True, 'numpy/text.py': False, 'pillow.libs/libexample.so.1': True})

    def test_package_is_deterministic_includes_data_and_never_replaces_the_handler(self):
        records = self.wheels(first=[('handler.py', b'foreign handler'), ('numpy/__init__.py', b'allowed')])
        root = self.fixture_source(); first, second = self.directory / 'a.zip', self.directory / 'b.zip'
        with patch.object(runtime, 'locked_wheels', return_value=records), patch.object(packager, 'ROOT', root):
            left = packager.package_api(first, self.directory); right = packager.package_api(second, self.directory)
        self.assertEqual(left, right); self.assertEqual(first.read_bytes(), second.read_bytes())
        with ZipFile(first) as archive:
            self.assertEqual(archive.read('handler.py'), b'reviewed handler')
            self.assertEqual(archive.read('models/doodlenet/weights.bin'), b'not executable model data')
            self.assertEqual(len(archive.namelist()), len(set(archive.namelist())))
            self.assertNotIn('sitecustomize.py', archive.namelist())

    def test_missing_or_corrupt_runtime_does_not_create_an_output_archive(self):
        records = self.wheels(); (self.directory / records[1]['filename']).unlink()
        root = self.fixture_source(); output = self.directory / 'refused.zip'
        with patch.object(runtime, 'locked_wheels', return_value=records), patch.object(packager, 'ROOT', root):
            with self.assertRaises(ValueError): packager.package_api(output, self.directory)
        self.assertFalse(output.exists())

    def test_source_symlinks_cannot_bundle_content_from_outside_the_repository(self):
        records = self.wheels(); root = self.fixture_source()
        outside = self.directory / 'outside.py'; outside.write_bytes(b'private synthetic outside content')
        (root / 'backend/nce_api/outside.py').symlink_to(outside)
        output = self.directory / 'refused-source.zip'
        with patch.object(runtime, 'locked_wheels', return_value=records), patch.object(packager, 'ROOT', root):
            with self.assertRaises(SystemExit): packager.package_api(output, self.directory)
        if output.exists():
            with ZipFile(output) as archive: self.assertNotIn('outside.py', archive.namelist())

    def test_prepare_default_is_plan_only_and_download_hash_failures_write_nothing(self):
        records = self.wheels(); destination = self.directory / 'download'
        with patch.object(prepare, 'locked_wheels', return_value=records), \
                patch.object(prepare, 'urlopen', side_effect=AssertionError('Planning cannot use the network.')), redirect_stdout(io.StringIO()):
            prepare.prepare(destination)
        self.assertFalse(destination.exists())
        class BadResponse:
            url = records[0]['url']
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, amount): return b'incorrect hash and size'
        with patch.object(prepare, 'locked_wheels', return_value=records), patch.object(prepare, 'urlopen', return_value=BadResponse()), redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError, 'differs'): prepare.prepare(destination, download=True)
        self.assertFalse(destination.exists())

    def test_committed_lock_selects_only_exact_cpython312_linux_arm64_pypi_artifacts(self):
        lock = json.loads((ROOT / 'config/sketch-runtime-lock.json').read_text())
        self.assertEqual((lock['version'], lock['python'], lock['platform']), (1, '3.12', 'linux-aarch64'))
        self.assertEqual({wheel['name'] for wheel in lock['wheels']}, {'numpy', 'pillow'})
        for wheel in lock['wheels']:
            self.assertRegex(wheel['filename'], r'-cp312-cp312-manylinux_2_27_aarch64\.manylinux_2_28_aarch64\.whl$')
            self.assertRegex(wheel['sha256'], r'^[a-f0-9]{64}$')
            self.assertTrue(wheel['url'].startswith('https://files.pythonhosted.org/packages/'))
            self.assertTrue(wheel['url'].endswith('/' + wheel['filename']))
            self.assertLess(wheel['size'], 30 * 1024 * 1024)

    def test_lean_relay_archive_needs_no_wheels_or_model_assets_and_contains_no_native_runtime(self):
        root = self.fixture_source(); models = root / 'backend/nce_api/models/doodlenet'
        for path in models.iterdir(): path.unlink()
        models.rmdir()
        output = self.directory / 'relay.zip'
        with patch.object(packager, 'ROOT', root), patch.object(packager, 'wheel_files', side_effect=AssertionError('Relay must not validate native wheels.')):
            packager.package_api(output, self.directory / 'nonexistent-wheels', include_sketch_runtime=False)
        with ZipFile(output) as archive:
            self.assertIn('multiplayer.py', archive.namelist())
            self.assertNotIn('sketch_vision.py', archive.namelist())
            self.assertFalse(any(name.startswith(('models/', 'numpy', 'PIL', 'pillow')) or name.endswith('.so') for name in archive.namelist()))

    def test_actual_relay_plan_uses_architecture_neutral_packaging_without_aws(self):
        release = module('test_relay_runtime_plan', ROOT / 'scripts/deploy-multiplayer.py')
        root = self.fixture_source(); output = self.directory / 'relay-plan'; output.mkdir()
        operation = SimpleNamespace(directory=output, verify_account=lambda: (_ for _ in ()).throw(AssertionError('No AWS in planning.')))
        arguments = ['--output', str(output), '--core-stack', 'nce-synthetic-core',
            '--application-id', '11111111-1111-4111-8111-111111111111',
            '--stack', 'game-studio-synthetic-multiplayer', '--profile', 'synthetic', '--expected-account', '111111111111']
        with patch.object(release.deployment, 'Deployment', return_value=operation), \
                patch.object(release.package, 'ROOT', root), \
                patch.object(release.package, 'wheel_files', side_effect=AssertionError('Relay cannot package ARM64 runtime.')), \
                patch.object(release.subprocess, 'check_output', return_value='a' * 40 + '\n'), redirect_stdout(io.StringIO()):
            self.assertEqual(release.main(arguments), 0)
        with ZipFile(output / 'multiplayer-api.zip') as archive:
            self.assertIn('multiplayer.py', archive.namelist())
            self.assertNotIn('sketch_vision.py', archive.namelist())
            self.assertFalse(any(name.startswith(('models/', 'numpy', 'PIL', 'pillow')) for name in archive.namelist()))

    def test_main_runtime_remains_strict_default_and_has_no_cli_disable_switch(self):
        self.assertIs(inspect.signature(packager.package_api).parameters['include_sketch_runtime'].default, True)
        with patch.object(sys, 'argv', ['package-api.py', '--without-sketch-runtime']), redirect_stdout(io.StringIO()), \
                redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as rejected:
                runpy.run_path(str(ROOT / 'scripts/package-api.py'), run_name='__main__')
        self.assertEqual(rejected.exception.code, 2)


if __name__ == '__main__':
    unittest.main()
