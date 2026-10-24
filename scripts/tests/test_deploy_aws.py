"""Local deployment guard checks; no AWS, provider, build or remote calls."""
import argparse
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / 'deploy-aws.py'
spec = importlib.util.spec_from_file_location('game_studio_deployment', MODULE)
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeploymentGuardTests(unittest.TestCase):
    def test_frontend_plan_never_contacts_aws(self):
        with tempfile.TemporaryDirectory() as folder:
            args = argparse.Namespace(output=folder, name='game-studio-example', branch='production', stack='game-studio-example-web', execute=False)
            operation = deploy.Deployment(args)
            with patch.object(operation, 'aws', side_effect=AssertionError('AWS must not be called')), redirect_stdout(io.StringIO()):
                operation.frontend()
            self.assertEqual(json.loads((Path(folder) / 'frontend-plan.json').read_text())['stack'], args.stack)

    def test_account_mismatch_stops(self):
        with tempfile.TemporaryDirectory() as folder:
            operation = deploy.Deployment(argparse.Namespace(output=folder, expected_account='111111111111', region='us-east-1', profile='example'))
            with patch.object(operation, 'aws', return_value={'Account': '222222222222'}):
                with self.assertRaisesRegex(RuntimeError, 'another account'):
                    operation.verify_account()

    def test_unrelated_stack_is_not_updated(self):
        with tempfile.TemporaryDirectory() as folder:
            operation = deploy.Deployment(argparse.Namespace(output=folder))
            with patch.object(operation, 'stack', return_value={'StackStatus': 'UPDATE_COMPLETE', 'Tags': []}), patch.object(operation, 'aws', side_effect=AssertionError('No mutation')):
                with self.assertRaisesRegex(RuntimeError, 'not tagged'):
                    operation.apply_stack('game-studio-example-api', Path('unused'), {})

    def test_existing_core_binding_is_immutable(self):
        with tempfile.TemporaryDirectory() as folder:
            operation = deploy.Deployment(argparse.Namespace(output=folder))
            previous = {'StackStatus': 'UPDATE_COMPLETE', 'Tags': [{'Key': 'nce:application-family', 'Value': 'game-studio'}], 'Parameters': [{'ParameterKey': 'CoreServiceId', 'ParameterValue': 'old'}]}
            with patch.object(operation, 'stack', return_value=previous), patch.object(operation, 'aws', side_effect=AssertionError('No mutation')):
                with self.assertRaisesRegex(RuntimeError, 'immutable'):
                    operation.apply_stack('game-studio-example-api', Path('unused'), {'CoreServiceId': 'new'}, core={'version': 1})

    def test_shared_core_stack_name_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            operation = deploy.Deployment(argparse.Namespace(output=folder))
            with patch.object(operation, 'aws', side_effect=AssertionError('No mutation')):
                with self.assertRaisesRegex(RuntimeError, 'dedicated'):
                    operation.apply_stack('axolotl-news-production', Path('unused'), {})

    def test_origins_reject_path_query_port_and_credentials(self):
        for value in ['http://example.com', 'https://example.com/', 'https://example.com/path', 'https://example.com?x=y', 'https://user@example.com', 'https://example.com:443', 'https://*.example.com']:
            with self.subTest(value=value), self.assertRaises(RuntimeError): deploy.exact_origin(value)
        self.assertEqual(deploy.exact_origin('https://games.example.com'), 'https://games.example.com')

    def test_public_config_never_accepts_a_secret(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'public.json'
            value = {'issuer': 'https://core.example.com', 'application_origin': 'https://games.example.com', 'redirect_uri': 'https://games.example.com/oauth/callback', 'organization_id': '00000000-0000-0000-0000-000000000001', 'service_id': '00000000-0000-0000-0000-000000000002', 'browser_client_id': 'public', 'client_secret': 'synthetic'}
            path.write_text(json.dumps(value))
            with self.assertRaisesRegex(RuntimeError, 'never credentials'): deploy.public_config(path)


if __name__ == '__main__': unittest.main()
