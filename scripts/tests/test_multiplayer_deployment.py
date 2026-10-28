"""Offline authorization and preservation checks for the additive room relay."""
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('deploy_multiplayer', ROOT / 'scripts/deploy-multiplayer.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
APP = '11111111-1111-4111-8111-111111111111'


class MultiplayerDeploymentTests(unittest.TestCase):
    def setUp(self):
        self.stack = {'StackStatus': 'UPDATE_COMPLETE', 'Tags': [{'Key': 'nce:application', 'Value': APP}],
                      'Parameters': [{'ParameterKey': k, 'ParameterValue': v} for k, v in {
                          'ApplicationIdentifier': APP, 'Archetype': 'amplify-game-studio',
                          'ApplicationOrigin': 'https://games.example.invalid', 'CoreOrganizationId': APP,
                          'CoreServiceId': APP, 'LambdaCodeBucket': 'private-artifacts'}.items()]}
        self.resources = [{'LogicalResourceId': 'PublishedGames', 'ResourceType': 'AWS::DynamoDB::Table',
                           'PhysicalResourceId': 'synthetic-published'}]

    def test_binding_uses_verified_publication_table_and_rejects_other_application(self):
        values = release.binding(self.stack, self.resources, APP)
        self.assertEqual(values['PublishedGamesTable'], 'synthetic-published')
        self.stack['Tags'][0]['Value'] = 'another-application'
        with self.assertRaises(RuntimeError):
            release.binding(self.stack, self.resources, APP)

    def test_private_table_cannot_be_selected_as_publication_source(self):
        self.resources[0]['LogicalResourceId'] = 'GameDrafts'
        with self.assertRaises(RuntimeError):
            release.binding(self.stack, self.resources, APP)

    def test_existing_extension_cannot_be_moved_to_another_tenant_or_origin(self):
        values = release.binding(self.stack, self.resources, APP)
        previous = {'Parameters': [{'ParameterKey': k, 'ParameterValue': v} for k, v in values.items()]}
        release.preserve_binding(previous, values)
        for key in ['ApplicationIdentifier', 'ApplicationOrigin', 'CoreOrganizationId', 'CoreServiceId', 'PublishedGamesTable']:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                release.preserve_binding(previous, {**values, key: 'different'})

    def test_routine_releases_retain_reviewed_legacy_alias_but_cannot_create_or_change_it(self):
        values = release.binding(self.stack, self.resources, APP)
        previous = {'Parameters': [{'ParameterKey': k, 'ParameterValue': v} for k, v in {**values, 'LegacyApplicationOrigin': 'https://legacy.example.invalid'}.items()]}
        release.preserve_binding(previous, values)
        self.assertEqual(values['LegacyApplicationOrigin'], 'https://legacy.example.invalid')
        self.assertEqual(release.public_configuration({'ApiUrl': 'https://relay.example.invalid'}, values), {'version': 1, 'apiUrl': 'https://relay.example.invalid', 'legacyApplicationOrigin': 'https://legacy.example.invalid'})
        self.assertEqual(release.public_configuration({'ApiUrl': 'https://relay.example.invalid'}, {}), {'version': 1, 'apiUrl': 'https://relay.example.invalid'})
        with self.assertRaises(RuntimeError):
            release.preserve_binding(previous, {**values, 'LegacyApplicationOrigin': 'https://unknown.example.invalid'})
        with self.assertRaises(RuntimeError):
            release.preserve_binding(None, values)
        for legacy in ('https://*.example.invalid', 'https://games.example.invalid'):
            broken = {'Parameters': [{'ParameterKey': k, 'ParameterValue': v} for k, v in {**values, 'LegacyApplicationOrigin': legacy}.items()]}
            with self.subTest(legacy=legacy), self.assertRaises(RuntimeError):
                release.preserve_binding(broken, {**values, 'LegacyApplicationOrigin': ''})

    def test_optional_alias_is_explicit_bounded_and_cors_defaults_to_primary_only(self):
        template = json.loads((ROOT / 'infra/aws/multiplayer.template.json').read_text())
        self.assertEqual(template['Parameters']['LegacyApplicationOrigin']['Default'], '')
        self.assertEqual(template['Parameters']['LegacyApplicationOrigin']['MaxLength'], 255)
        env = template['Resources']['Relay']['Properties']['Environment']['Variables']
        self.assertEqual(env['LEGACY_FRONTEND_ORIGIN'], {'Ref': 'LegacyApplicationOrigin'})
        cors = template['Resources']['Http']['Properties']['CorsConfiguration']['AllowOrigins']
        self.assertEqual(cors, {'Fn::If': ['HasLegacyApplicationOrigin', [{'Ref': 'ApplicationOrigin'}, {'Ref': 'LegacyApplicationOrigin'}], [{'Ref': 'ApplicationOrigin'}]]})
        self.assertEqual(template['Rules']['DistinctFrontendOrigins']['Assertions'][0]['Assert'], {'Fn::Not': [{'Fn::Equals': [{'Ref': 'ApplicationOrigin'}, {'Ref': 'LegacyApplicationOrigin'}]}]})

    def test_runtime_has_no_private_data_core_credential_or_provider_authority(self):
        template = json.loads((ROOT / 'infra/aws/multiplayer.template.json').read_text())
        resources = template['Resources']
        statements = resources['Role']['Properties']['Policies'][0]['PolicyDocument']['Statement']
        actions = {action for row in statements for action in row['Action']}
        self.assertEqual(actions, {'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem',
                                   'dynamodb:ConditionCheckItem', 'execute-api:ManageConnections',
                                   'logs:CreateLogStream', 'logs:PutLogEvents'})
        published = next(row for row in statements if 'PublishedGamesTable' in json.dumps(row))
        self.assertEqual(set(published['Action']), {'dynamodb:GetItem', 'dynamodb:ConditionCheckItem'})
        callback = next(row for row in statements if 'execute-api:ManageConnections' in row['Action'])
        self.assertEqual(callback['Resource'], {'Fn::Sub': 'arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${Socket}/production/*/@connections/*'})
        env = resources['Relay']['Properties']['Environment']['Variables']
        self.assertNotIn('CORE_CREDENTIALS_PARAMETER', env)
        self.assertNotIn('GAME_DRAFT_TABLE', env)
        self.assertEqual(resources['Relay']['Properties']['Handler'], 'multiplayer.handler')

    def test_expiring_table_preserved_and_socket_payload_logging_disabled(self):
        resources = json.loads((ROOT / 'infra/aws/multiplayer.template.json').read_text())['Resources']
        room = resources['Rooms']
        self.assertEqual(room['DeletionPolicy'], room['UpdateReplacePolicy'])
        self.assertEqual(room['DeletionPolicy'], 'Retain')
        self.assertEqual(room['Properties']['TimeToLiveSpecification'], {'AttributeName': 'expiresAt', 'Enabled': True})
        self.assertTrue(room['Properties']['SSESpecification']['SSEEnabled'])
        stage = resources['SocketStage']['Properties']
        self.assertFalse(stage['DefaultRouteSettings']['DataTraceEnabled'])
        self.assertEqual(stage['DefaultRouteSettings']['LoggingLevel'], 'OFF')
        self.assertNotIn('AccessLogSettings', stage)


if __name__ == '__main__':
    unittest.main()
