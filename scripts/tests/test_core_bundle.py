"""Synthetic, offline integrity/tampering checks for the packaged Core patch."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
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

    def test_complete_bundle_and_explicit_template_context_provenance_records_match(self):
        result = bundle.validate_bundle(ROOT)
        self.assertEqual(result['files'], 19)
        self.assertEqual(result['templateBytes'], 51129)
        self.assertEqual(result['templateSource'], bundle.TEMPLATE_SOURCE)
        self.assertEqual(result['gameRecipeBytes'], 30629)
        self.assertEqual(result['gameRecipeSource'], bundle.TEMPLATE_SOURCE)
        self.assertEqual(result['contextBytes'], 13139)

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
        for index in [0, 1, 2]:
            for field, value in [('commit', 'f' * 40), ('repository', 'Other/Core'), ('path', 'other.json'), ('sha256', 'f' * 64)]:
                with self.subTest(index=index, field=field), tempfile.TemporaryDirectory() as directory:
                    root = self.fixture(directory)
                    p = root / 'nce/core-patch-baseline.json'
                    metadata = json.loads(p.read_text()); metadata['per_file_overrides'][index][field] = value
                    p.write_text(json.dumps(metadata))
                    with self.assertRaisesRegex(ValueError, 'override provenance'):
                        bundle.validate_bundle(root)

    def test_duplicate_missing_and_foreign_override_records_are_rejected(self):
        for kind in ['duplicate', 'missing', 'foreign']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root = self.fixture(directory)
                p = root / 'nce/core-patch-baseline.json'; metadata = json.loads(p.read_text())
                if kind == 'duplicate': metadata['per_file_overrides'][1] = copy.deepcopy(metadata['per_file_overrides'][0])
                elif kind == 'missing': metadata['per_file_overrides'].pop()
                else: metadata['per_file_overrides'][1]['path'] = 'foreign.json'
                p.write_text(json.dumps(metadata))
                with self.assertRaises(ValueError): bundle.validate_bundle(root)

    def test_frontend_binding_stays_disabled_literal_runner_only_and_region_bound(self):
        template = json.loads(bundle.full_template_section((ROOT / 'nce/core-onboarding.patch').read_bytes()))
        for kind in ['enabled-default', 'wildcard-input', 'condition', 'role', 'action', 'resource', 'region']:
            with self.subTest(kind=kind):
                changed = copy.deepcopy(template)
                policy = changed['Resources']['GameStudioFrontendPublishPolicy']; grant = policy['Properties']['PolicyDocument']['Statement'][0]
                if kind == 'enabled-default': changed['Parameters']['GameStudioFrontendAppId']['Default'] = 'dother'
                elif kind == 'wildcard-input': changed['Parameters']['GameStudioFrontendAppId']['AllowedPattern'] = '.*'
                elif kind == 'condition': policy['Condition'] = 'Serverless'
                elif kind == 'role': policy['Properties']['Roles'] = [{'Ref': 'SourceRole'}]
                elif kind == 'action': grant['Action'].append('amplify:DeleteApp')
                elif kind == 'resource': grant['Resource'] = '*'
                else: grant.pop('Condition')
                with self.assertRaisesRegex(ValueError, 'frontend binding'):
                    bundle.validate_frontend_binding_scope(changed)

    def test_game_default_route_permission_is_exact_and_legacy_permission_is_preserved(self):
        template = json.loads(bundle.full_template_section((ROOT / 'nce/core-onboarding.patch').read_bytes(), bundle.GAME_TEMPLATE_PATH))
        for kind in ['wildcard-arn', 'other-function', 'principal', 'account', 'legacy', 'stage', 'extra']:
            with self.subTest(kind=kind):
                changed = copy.deepcopy(template); resources = changed['Resources']; grant = resources['ApiDefaultInvoke']['Properties']
                if kind == 'wildcard-arn': grant['SourceArn']['Fn::Sub'] = 'arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${Api}/*/*'
                elif kind == 'other-function': grant['FunctionName'] = {'Ref': 'OtherFunction'}
                elif kind == 'principal': grant['Principal'] = '*'
                elif kind == 'account': grant.pop('SourceAccount')
                elif kind == 'legacy': resources['ApiInvoke']['Properties']['SourceArn']['Fn::Sub'] = '*'
                elif kind == 'stage': resources['ApiDefaultStage']['Properties']['StageName'] = 'preview'
                else: resources['OtherInvoke'] = copy.deepcopy(resources['ApiDefaultInvoke'])
                with self.assertRaisesRegex(ValueError, 'game recipe'):
                    bundle.validate_game_recipe_scope(changed)

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

    def test_spa_routes_return_200_without_capturing_dotted_assets_or_sdk_files(self):
        template = json.loads(bundle.full_template_section((ROOT / 'nce/core-onboarding.patch').read_bytes(), bundle.GAME_TEMPLATE_PATH))
        rule = template['Resources']['Frontend']['Properties']['CustomRules'][0]
        pattern = re.compile(rule['Source'][2:-2])
        for route in ['/', '/games', '/game-studio', '/oauth/callback', '/settings/integration', '/embed/games/example']:
            with self.subTest(route=route): self.assertIsNotNone(pattern.fullmatch(route))
        for path in ['/assets/missing.js', '/assets/theme.css', '/sdk/game-studio.js', '/favicon.ico']:
            with self.subTest(path=path): self.assertIsNone(pattern.fullmatch(path))
        for field, value in [('Source', '/<*>'), ('Target', '/missing.html'), ('Status', '404-200')]:
            with self.subTest(field=field):
                changed = copy.deepcopy(template)
                changed['Resources']['Frontend']['Properties']['CustomRules'][0][field] = value
                with self.assertRaisesRegex(ValueError, 'SPA rewrite'):
                    bundle.validate_game_recipe_scope(changed)

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
