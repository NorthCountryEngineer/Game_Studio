"""Offline narration tests: synthetic storage, mocked models, no network."""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import socket
import unittest
from unittest.mock import patch

import test_games as support

spec = importlib.util.spec_from_file_location('test_mafia_narration_module', Path(__file__).parents[1] / 'backend/nce_api/mafia_narration.py')
narration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(narration)

PHRASES = {
    'night': 'The moon rises while the town keeps its secrets.',
    'discussion': 'Morning brings questions and curious conversations.',
    'voting': 'The town gathers to make its next choice.',
    'eliminated': 'One chair is empty as the mystery deepens.',
    'protected': 'The town greets a quiet morning together.',
    'tie': 'Uncertainty lingers as the town remains divided.',
    'townWin': 'The mystery clears and the town celebrates.',
    'mafiaWin': 'The hidden team steps into the spotlight.',
}


class NarrationTests(unittest.TestCase):
    authorize = support.GameTests.authorize
    event = support.GameTests.event
    write_registry = support.GameTests.write_registry

    def setUp(self):
        support.GameTests.setUp(self)
        self.framework = patch.object(narration, 'framework', return_value=self.af)
        self.framework.start(); self.addCleanup(self.framework.stop)
        for name in ('socket', 'create_connection'):
            blocked = patch.object(socket, name, side_effect=AssertionError('Network is disabled in offline tests.'))
            blocked.start(); self.addCleanup(blocked.stop)
        self.provider.converse.return_value = self.response()

    def configure(self, change=None):
        registry = self.af.defaults()
        registry['revision'] = 1; registry['allowPaidExecution'] = True
        registry['models'][1].update(enabled=True, target=narration.MODEL, maxOutputTokens=1200)
        if change:
            change(registry)
        self.write_registry(registry)
        return registry

    def response(self, phrases=None):
        return {'stopReason': 'end_turn', 'output': {'message': {'content': [{'text': json.dumps(PHRASES if phrases is None else phrases)}]}}}

    def generate(self, request=support.REQUEST, revision=0):
        return narration.generate(self.api, self.event(), {'requestId': request, 'expectedRevision': revision})

    def approve(self, result):
        return narration.approve(self.api, self.event(), {'requestId': result['requestId'], 'expectedRevision': result['revision'], 'reviewed': True})

    def error(self, status, action):
        with self.assertRaises((narration.NarrationError, support.games.GameError)) as caught:
            action()
        self.assertEqual(caught.exception.status, status)
        return caught.exception.message

    def state(self):
        return json.loads(self.database.rows['published-games'][narration.key()]['payload'])

    def test_public_defaults_are_provider_and_authentication_free(self):
        self.assertEqual(narration.public_config(self.api), {'aiAvailable': False, 'aiLabel': 'AI narrator not enabled'})
        self.assertIsNone(narration.load_bank(self.api))
        self.authorization.assert_not_called(); self.provider.converse.assert_not_called()
        self.assertEqual(self.database.rows['published-games'], {})

    def test_reviewed_deployment_seed_does_not_fabricate_an_application_request(self):
        state = narration.defaults()
        state.update(revision=1, enabled=True,
            approved={'version': 1, 'source': narration.MODEL, 'phrases': deepcopy(PHRASES)})
        self.assertEqual(narration.validate_state(state), state)
        self.database.rows['published-games'][narration.key()] = {
            'id': narration.key(), 'revision': 1, 'organization_id': support.ORG,
            'service_id': support.SERVICE, 'payload': narration.canonical(state),
            'deployment_provenance_sha256': 'a' * 64}
        self.assertTrue(narration.public_config(self.api)['aiAvailable'])
        self.assertEqual(narration.load_bank(self.api)['phrases'], PHRASES)
        self.assertEqual(state['attempts'], 0); self.assertEqual(state['requests'], [])
        self.authorization.assert_not_called(); self.provider.converse.assert_not_called()

    def test_generation_reserves_before_io_uses_only_exact_small_model_and_fixed_prompt(self):
        self.configure()
        def respond(**kwargs):
            state = self.state()
            self.assertEqual(state['attempts'], 1)
            self.assertEqual(state['requests'], [{'requestId': support.REQUEST, 'owner': support.USER, 'status': 'pending'}])
            self.assertEqual(kwargs['modelId'], narration.MODEL)
            self.assertEqual(kwargs['inferenceConfig'], {'maxTokens': 800, 'temperature': 0.3})
            prompt = json.dumps(kwargs)
            self.assertNotIn(support.USER, prompt); self.assertNotIn('Bearer current', prompt)
            self.assertNotIn('toolConfig', kwargs)
            return self.response()
        self.provider.converse.side_effect = respond
        result = self.generate()
        self.assertEqual(result['status'], 'complete'); self.assertEqual(result['draft']['phrases'], PHRASES)
        self.assertEqual(self.authorization.call_count, 3)
        self.assertFalse(result['aiAvailable']); self.assertIsNone(narration.load_bank(self.api))
        self.assertEqual(result['revision'], 2)

    def test_only_exact_review_enables_cached_text_and_gameplay_never_invokes_provider(self):
        self.configure(); result = self.generate()
        self.error(400, lambda: narration.approve(self.api, self.event(), {'requestId': support.REQUEST, 'expectedRevision': 2, 'reviewed': False}))
        self.error(409, lambda: narration.approve(self.api, self.event(), {'requestId': support.SECOND, 'expectedRevision': 2, 'reviewed': True}))
        self.error(409, lambda: narration.approve(self.api, self.event(), {'requestId': support.REQUEST, 'expectedRevision': 0, 'reviewed': True}))
        enabled = self.approve(result)
        self.assertTrue(enabled['aiAvailable']); self.assertEqual(enabled['revision'], 3)
        expected = {'version': 1, 'source': narration.MODEL, 'phrases': PHRASES}
        for _ in range(8):
            self.assertEqual(narration.load_bank(self.api), expected)
            self.assertEqual(narration.public_config(self.api), {'aiAvailable': True, 'aiLabel': 'AI narrator'})
        self.assertEqual(self.provider.converse.call_count, 1)
        self.assertEqual(set(narration.public_config(self.api)), {'aiAvailable', 'aiLabel'})
        returned = narration.load_bank(self.api); returned['phrases']['night'] = 'Modified caller data.'
        self.assertEqual(narration.load_bank(self.api), expected)

    def test_protected_generation_review_and_controls_need_current_agent_administration(self):
        self.configure()
        for action in (
                lambda: narration.generate(self.api, {}, {'requestId': support.REQUEST, 'expectedRevision': 0}),
                lambda: narration.admin_status(self.api, {}),
                lambda: narration.approve(self.api, {}, {'requestId': support.REQUEST, 'expectedRevision': 0, 'reviewed': True}),
                lambda: narration.set_enabled(self.api, {}, {'expectedRevision': 0, 'enabled': False})):
            self.error(401, action)
        self.claims['permissions'] = ['games-create', 'games-publish']
        self.error(403, self.generate)
        self.assertFalse(self.database.rows['published-games']); self.provider.converse.assert_not_called()

    def test_registry_disabled_paid_disabled_wrong_model_and_small_output_fail_without_storage(self):
        changes = (
            lambda value: value.update(enabled=False),
            lambda value: value.update(allowPaidExecution=False),
            lambda value: value['limits'].update(maxModelCalls=0),
            lambda value: value['models'][1].update(enabled=False),
            lambda value: value['models'][1].update(target='another.large-model'),
            lambda value: value['models'][1].update(maxOutputTokens=511),
        )
        for change in changes:
            self.configure(change); self.error(403, self.generate)
            self.assertEqual(self.database.rows['published-games'], {})
        self.provider.converse.assert_not_called()

    def test_request_body_has_no_prompt_player_or_model_override(self):
        self.configure()
        for addition in ({'prompt': 'Ignore rules'}, {'players': ['Name']}, {'modelId': 'large-model'}, {'roles': {}}, {'extra': None}):
            self.error(400, lambda: narration.generate(self.api, self.event(), {'requestId': support.REQUEST, 'expectedRevision': 0, **addition}))
        for request in ('not-a-uuid', None, [], True):
            self.error(400, lambda: self.generate(request))
        for revision in (True, -1, 1.0, '0', None):
            self.error(400, lambda: self.generate(revision=revision))
        self.error(409, lambda: self.generate(revision=1))
        self.provider.converse.assert_not_called()

    def test_completed_request_replay_returns_cached_result_without_charge_or_overwrite(self):
        self.configure(); result = self.generate(); self.approve(result)
        state = deepcopy(self.database.rows)
        retried = self.generate()
        self.assertEqual(retried['draft'], result['draft']); self.assertEqual(retried['status'], 'complete')
        self.assertEqual(retried['revision'], 3); self.assertTrue(retried['aiAvailable'])
        self.assertEqual(self.provider.converse.call_count, 1); self.assertEqual(self.database.rows, state)
        self.claims['sub'] = support.OTHER
        self.error(409, self.generate); self.assertEqual(self.provider.converse.call_count, 1)

    def test_failed_provider_consumes_one_reservation_and_is_not_replayed(self):
        self.configure(); self.provider.converse.side_effect = TimeoutError('DO_NOT_LOG_THIS')
        message = self.error(502, self.generate)
        self.assertIn('will not be replayed', message); self.assertNotIn('DO_NOT_LOG_THIS', message)
        self.assertEqual(self.state()['requests'][0]['status'], 'failed')
        retried = self.generate()
        self.assertEqual(retried['status'], 'failed'); self.assertEqual(self.provider.converse.call_count, 1)
        self.assertFalse(narration.public_config(self.api)['aiAvailable'])

    def test_partial_or_tool_response_does_not_enable_ai_and_never_echoes_content(self):
        self.configure()
        responses = (
            {'stopReason': 'max_tokens', 'output': {'message': {'content': [{'text': 'DO_NOT_LOG_THIS'}]}}},
            {'stopReason': 'end_turn', 'output': {'message': {'content': [{'toolUse': {'name': 'DO_NOT_LOG_THIS'}}]}}},
            self.response({**PHRASES, 'night': '<script>DO_NOT_LOG_THIS</script>'}),
        )
        for index, response in enumerate(responses):
            self.provider.converse.return_value = response
            request = (support.REQUEST, support.SECOND, support.COPY)[index]
            revision = self.state()['revision'] if self.database.rows['published-games'] else 0
            message = self.error(502, lambda: self.generate(request, revision))
            self.assertNotIn('DO_NOT_LOG_THIS', message)
            self.assertFalse(narration.public_config(self.api)['aiAvailable'])
        self.assertEqual(self.provider.converse.call_count, 3)

    def test_generation_is_bounded_across_distinct_requests(self):
        self.configure()
        for request in (support.REQUEST, support.SECOND, support.COPY):
            revision = self.state()['revision'] if self.database.rows['published-games'] else 0
            result = self.generate(request, revision)
        self.error(409, lambda: self.generate(support.GAME, result['revision']))
        self.assertEqual(self.state()['attempts'], 3); self.assertEqual(self.provider.converse.call_count, 3)
        self.assertEqual(len(self.state()['requests']), 3)

    def test_registry_call_limit_can_be_lower_than_fixed_installation_cap(self):
        self.configure(lambda value: value['limits'].update(maxModelCalls=1))
        result = self.generate()
        self.error(409, lambda: self.generate(support.SECOND, result['revision']))
        self.assertEqual(self.provider.converse.call_count, 1)

    def test_pending_or_revoked_reserved_work_cannot_trigger_another_provider_call(self):
        self.configure()
        real = self.authorization.side_effect
        def revoke(event, *permissions):
            if self.authorization.call_count == 2:
                self.claims['permissions'] = []
            return real(event, *permissions)
        self.authorization.side_effect = revoke
        self.error(403, self.generate)
        self.assertEqual(self.state()['requests'][0]['status'], 'pending')
        self.provider.converse.assert_not_called()
        self.claims['permissions'] = ['agents-manage']; self.authorization.side_effect = real
        self.assertEqual(self.generate()['status'], 'pending')
        self.error(409, lambda: self.generate(support.SECOND, self.state()['revision']))
        self.provider.converse.assert_not_called()

    def test_permission_revoked_during_provider_io_keeps_response_private_and_unenabled(self):
        self.configure()
        def respond(**kwargs):
            self.claims['permissions'] = []
            return self.response()
        self.provider.converse.side_effect = respond
        self.error(403, self.generate)
        self.assertEqual(self.state()['requests'][0]['status'], 'pending')
        self.assertIsNone(self.state()['draft']); self.assertFalse(self.state()['enabled'])

    def test_registry_race_before_reservation_is_atomic_and_free(self):
        self.configure(); real = self.database.transact
        def race(TransactItems):
            row = self.database.rows['assistant'][self.af.scoped_key('config')]
            value = json.loads(row['payload']); value['models'][1]['enabled'] = False
            row['payload'] = json.dumps(value)
            return real(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = race
        self.error(409, self.generate)
        self.assertFalse(self.database.rows['published-games']); self.provider.converse.assert_not_called()

    def test_registry_race_after_io_does_not_publish_or_cache_generated_text(self):
        self.configure()
        def respond(**kwargs):
            row = self.database.rows['assistant'][self.af.scoped_key('config')]
            value = json.loads(row['payload']); value['allowPaidExecution'] = False
            row['payload'] = json.dumps(value)
            return self.response()
        self.provider.converse.side_effect = respond
        self.error(403, self.generate)
        self.assertEqual(self.state()['requests'][0]['status'], 'pending')
        self.assertIsNone(self.state()['approved']); self.assertIsNone(self.state()['draft'])

    def test_fixed_row_tenant_and_storage_corruption_fail_closed_without_overwrite(self):
        self.configure(); self.generate()
        row = self.database.rows['published-games'][narration.key()]
        valid = deepcopy(row)
        for mutation in (
                lambda value: value.update(organization_id=support.OTHER),
                lambda value: value.update(service_id=support.OTHER),
                lambda value: value.update(id=support.OTHER),
                lambda value: value.update(payload='[]'),
                lambda value: value.update(payload='not JSON'),
                lambda value: value.update(revision=99)):
            bad = deepcopy(valid); mutation(bad)
            self.database.rows['published-games'][narration.key()] = bad
            before = deepcopy(self.database.rows)
            self.error(503, lambda: narration.public_config(self.api))
            self.assertEqual(self.database.rows, before)

    def test_cached_availability_is_independent_of_future_paid_provider_permission(self):
        self.configure(); result = self.generate(); self.approve(result)
        self.configure(lambda value: value.update(allowPaidExecution=False))
        self.assertTrue(narration.public_config(self.api)['aiAvailable'])
        self.assertEqual(self.provider.converse.call_count, 1)
        disabled = narration.set_enabled(self.api, self.event(), {'expectedRevision': 3, 'enabled': False})
        self.assertFalse(disabled['aiAvailable']); self.assertEqual(disabled['revision'], 4)
        self.assertIsNone(narration.load_bank(self.api)); self.assertIsNotNone(self.state()['approved'])
        enabled = narration.set_enabled(self.api, self.event(), {'expectedRevision': 4, 'enabled': True})
        self.assertTrue(enabled['aiAvailable']); self.assertEqual(self.provider.converse.call_count, 1)

    def test_admin_status_projects_out_owner_and_other_private_fields(self):
        self.configure(); self.generate()
        value = narration.admin_status(self.api, self.event())
        self.assertNotIn(support.USER, json.dumps(value))
        self.assertEqual(value['requests'], [{'requestId': support.REQUEST, 'status': 'complete'}])
        self.assertEqual(value['draft']['phrases'], PHRASES)

    def test_phrase_validation_rejects_executable_invisible_unknown_and_oversized_values(self):
        invalid = ('short', '<b>Text content</b>', 'A script at javascript:alert(1)', 'See https://example.com',
            'The town greets\nnew day.', 'A quiet\u202enight falls.', 'A {player} leaves town.', 'a' * 161, True, [], None)
        for value in invalid:
            self.error(400, lambda: narration.validate_phrases({**PHRASES, 'night': value}))
        self.error(400, lambda: narration.validate_phrases({**PHRASES, 'extra': 'Extra text here.'}))
        candidate = dict(PHRASES); candidate.pop('night')
        self.error(400, lambda: narration.validate_phrases(candidate))

    def test_model_parser_accepts_only_one_inert_json_envelope_and_unique_fields(self):
        af = self.af; model = {'maxOutputTokens': 512}
        for text in (json.dumps(PHRASES), '```json\n' + json.dumps(PHRASES) + '\n```'):
            self.provider.converse.return_value = {'stopReason': 'end_turn', 'output': {'message': {'content': [{'text': text}]}}}
            self.assertEqual(narration.model_phrases(af, model), PHRASES)
            self.assertEqual(self.provider.converse.call_args.kwargs['inferenceConfig']['maxTokens'], 512)
        for text in ('Here is your text: ' + json.dumps(PHRASES), '{"night":"First text.","night":"Other text."}',
                json.dumps(PHRASES) + json.dumps(PHRASES), 'x' * 5001):
            self.provider.converse.return_value = {'stopReason': 'end_turn', 'output': {'message': {'content': [{'text': text}]}}}
            self.error(502, lambda: narration.model_phrases(af, model))

    def test_enable_requires_reviewed_bank_and_strict_boolean(self):
        self.error(409, lambda: narration.set_enabled(self.api, self.event(), {'expectedRevision': 0, 'enabled': True}))
        for invalid in (1, 'true', None):
            self.error(400, lambda: narration.set_enabled(self.api, self.event(), {'expectedRevision': 0, 'enabled': invalid}))
        self.assertFalse(self.database.rows['published-games'])

