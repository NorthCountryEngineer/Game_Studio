"""Synthetic, offline integrity/tampering checks for the packaged Core patch."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('game_studio_core_bundle', ROOT / 'scripts/core_bundle.py')
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class CoreBundleTests(unittest.TestCase):
    def fixture(self, directory):
        root = Path(directory)
        (root / 'nce').mkdir()
        for name in ['core-onboarding.patch', 'core-patch-baseline.json']:
            (root / 'nce' / name).write_bytes((ROOT / 'nce' / name).read_bytes())
        return root

    def update_manifest_hash(self, root):
        metadata_path = root / 'nce/core-patch-baseline.json'
        metadata = json.loads(metadata_path.read_text())
        metadata['patch_sha256'] = hashlib.sha256((root / 'nce/core-onboarding.patch').read_bytes()).hexdigest()
        metadata_path.write_text(json.dumps(metadata))

    def test_complete_bundle_template_and_explicit_template_only_provenance_match(self):
        result = bundle.validate_bundle(ROOT)
        self.assertEqual(result['files'], 18)
        self.assertEqual(result['templateBytes'], 51175)
        self.assertEqual(result['templateSource'], bundle.TEMPLATE_SOURCE)

    def test_changed_patch_bytes_without_manifest_update_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            p = root / 'nce/core-onboarding.patch'
            p.write_bytes(p.read_bytes() + b'\n')
            with self.assertRaisesRegex(ValueError, 'complete Core patch hash'):
                bundle.validate_bundle(root)

    def test_duplicate_template_section_is_rejected_even_with_new_whole_patch_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            p = root / 'nce/core-onboarding.patch'
            marker = ('diff --git a/' + bundle.TEMPLATE_PATH + ' b/' + bundle.TEMPLATE_PATH + '\n').encode()
            section = p.read_bytes().split(marker, 1)[1].split(b'\ndiff --git ', 1)[0]
            p.write_bytes(p.read_bytes() + marker + section)
            self.update_manifest_hash(root)
            with self.assertRaisesRegex(ValueError, 'complete Core patch hash'):
                bundle.validate_bundle(root)
            with self.assertRaisesRegex(ValueError, 'exactly one full platform template section'):
                bundle.full_template_section(p.read_bytes())

    def test_claimed_template_source_hash_or_override_cannot_be_substituted(self):
        for field, value in [('commit', 'f' * 40), ('repository', 'Other/Core'), ('path', 'other.json'), ('sha256', 'f' * 64)]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                root = self.fixture(directory)
                p = root / 'nce/core-patch-baseline.json'
                metadata = json.loads(p.read_text()); metadata['per_file_overrides'][0][field] = value
                p.write_text(json.dumps(metadata))
                with self.assertRaisesRegex(ValueError, 'override provenance'):
                    bundle.validate_bundle(root)

    def test_changed_file_set_and_false_template_hash_are_rejected(self):
        for kind in ['file-set', 'template-hash']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root = self.fixture(directory)
                p = root / 'nce/core-patch-baseline.json'
                metadata = json.loads(p.read_text())
                if kind == 'file-set': metadata['files'].pop(bundle.TEMPLATE_PATH)
                else: metadata['files'][bundle.TEMPLATE_PATH] = 'f' * 64
                p.write_text(json.dumps(metadata))
                with self.assertRaises(ValueError): bundle.validate_bundle(root)

    def test_non_template_manifest_hashes_remain_bound_to_the_apply_verified_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            p = root / 'nce/core-patch-baseline.json'
            metadata = json.loads(p.read_text())
            other = next(path for path in metadata['files'] if path != bundle.TEMPLATE_PATH)
            metadata['files'][other] = 'f' * 64
            p.write_text(json.dumps(metadata))
            with self.assertRaisesRegex(ValueError, 'complete post-patch manifest'):
                bundle.validate_bundle(root)

    def test_broader_or_missing_api_creation_conditions_and_actions_are_rejected(self):
        template = json.loads(bundle.full_template_section((ROOT / 'nce/core-onboarding.patch').read_bytes()))
        for sid in ['TagHttpApiForCloudFormation', 'CreateTaggedHttpApiChildren', 'TagHttpApiStages']:
            for kind in ['action', 'resource', 'condition', 'tag-context', 'missing', 'duplicate']:
                with self.subTest(sid=sid, kind=kind):
                    changed = copy.deepcopy(template)
                    statements = changed['Resources']['CloudFormationRole']['Properties']['Policies'][0]['PolicyDocument']['Statement']
                    grant = next(item for item in statements if item.get('Sid') == sid)
                    if kind == 'action': grant['Action'] = ['apigateway:*']
                    elif kind == 'resource': grant['Resource'] = '*'
                    elif kind == 'condition': grant.pop('Condition')
                    elif kind == 'tag-context': grant['Condition'] = {'StringEqualsIfExists': grant['Condition']['StringEquals']}
                    elif kind == 'duplicate': statements.append(copy.deepcopy(grant))
                    else: statements.remove(grant)
                    with self.assertRaisesRegex(ValueError, 'grant escaped'):
                        bundle.validate_template_scope(changed)
            original = next(item for item in template['Resources']['CloudFormationRole']['Properties']['Policies'][0]['PolicyDocument']['Statement'] if item.get('Sid') == sid)
            for key in original['Condition']['StringEquals']:
                with self.subTest(sid=sid, missing_context=key):
                    changed = copy.deepcopy(template)
                    grant = next(item for item in changed['Resources']['CloudFormationRole']['Properties']['Policies'][0]['PolicyDocument']['Statement'] if item.get('Sid') == sid)
                    grant['Condition']['StringEquals'].pop(key)
                    with self.assertRaisesRegex(ValueError, 'grant escaped'):
                        bundle.validate_template_scope(changed)
        changed = copy.deepcopy(template)
        changed['Resources']['CloudFormationRole']['Properties']['Policies'][0]['PolicyDocument']['Statement'].append({
            'Sid': 'UnreviewedApiAccess', 'Effect': 'Allow', 'Action': ['apigateway:POST'], 'Resource': '*'})
        with self.assertRaisesRegex(ValueError, 'gained another grant'):
            bundle.validate_template_scope(changed)

    def test_template_hash_prevents_content_substitution_after_manifest_rehash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            p = root / 'nce/core-onboarding.patch'
            original = p.read_bytes(); changed = original.replace(b'"TagHttpApiForCloudFormation"', b'"TagHttpApiForCloudFormatiox"')
            self.assertNotEqual(original, changed)
            p.write_bytes(changed); self.update_manifest_hash(root)
            with self.assertRaisesRegex(ValueError, 'complete Core patch hash'):
                bundle.validate_bundle(root)


if __name__ == '__main__': unittest.main()
