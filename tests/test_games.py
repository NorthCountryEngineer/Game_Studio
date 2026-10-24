"""Offline game security and concurrency tests. No model, AWS, or network calls."""
from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

from test_nce_api import MemoryDatabase

ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('games_test_module', ROOT / 'backend/nce_api/games.py')
games = importlib.util.module_from_spec(spec); spec.loader.exec_module(games)
hs = importlib.util.spec_from_file_location('games_handler_test_module', ROOT / 'backend/nce_api/handler.py')
handler = importlib.util.module_from_spec(hs); hs.loader.exec_module(handler)
GAME = '11111111-1111-4111-8111-111111111111'
ORG = '22222222-2222-4222-8222-222222222222'
SERVICE = '33333333-3333-4333-8333-333333333333'
USER = '44444444-4444-4444-8444-444444444444'
OTHER = '55555555-5555-4555-8555-555555555555'
COPY = '66666666-6666-4666-8666-666666666666'
REQUEST = '77777777-7777-4777-8777-777777777777'
SECOND = '88888888-8888-4888-8888-888888888888'


class GameTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'CORE_ORGANIZATION_ID': ORG, 'CORE_SERVICE_ID': SERVICE,
            'GAME_DRAFT_TABLE': 'games', 'GAME_PUBLIC_TABLE': 'published-games', 'ASSISTANT_TABLE': 'assistant'})
        self.env.start(); self.addCleanup(self.env.stop)
        self.database = MemoryDatabase(); self.database.rows.update({'games': {}, 'published-games': {}, 'assistant': {}})
        self.claims = {'sub': USER, 'permissions': ['games-create', 'games-publish', 'games-manage', 'agents-manage']}
        self.authorization = Mock(side_effect=self.authorize)
        self.api = types.SimpleNamespace(clients=lambda: (self.database, None, None), authorize=self.authorization)
        self.provider = Mock()
        self.af = games.framework()
        self.patched_provider = patch.object(self.af, 'provider', return_value=self.provider)
        self.patched_provider.start(); self.addCleanup(self.patched_provider.stop)
        self.provider.converse.return_value = {'output': {'message': {'content': [{'text': json.dumps({'text': 'Here is your space adventure.', 'spec': games.design_game('a pond collection game')['spec']})}]}}}

    def authorize(self, event, *permissions):
        if event.get('headers', {}).get('authorization') != 'Bearer current': raise games.GameError(401, 'Sign in.')
        if any(value not in self.claims['permissions'] for value in permissions): raise games.GameError(403, 'Permission denied.')
        return deepcopy(self.claims)

    def event(self):
        return {'headers': {'authorization': 'Bearer current'}}

    def error(self, status, fn):
        with self.assertRaises(games.GameError) as caught: fn()
        self.assertEqual(caught.exception.status, status)

    def create(self, game=GAME, prompt='a pond collection game'):
        return games.create(self.api, self.claims, {'id': game, 'prompt': prompt})

    def message(self, state, message='make it a space platformer', request=REQUEST):
        return games.conversation(self.api, self.claims, state['id'], {'revision': state['revision'], 'requestId': request, 'message': message}, self.event())

    def finish_test(self, state):
        return games.complete_test(self.api, self.claims, state['id'], {'revision': state['revision'],
            'reviewedLevelIds': [level['id'] for level in state['spec'].get('levels', [{'id': 'level-1'}])]})

    def publish(self, state):
        return games.publication(self.api, self.claims, state['id'], {'revision': state['revision']}, True)

    def save_config(self, change):
        value = games.settings(self.api, self.claims)['config']; change(value)
        return games.put_config(self.api, self.claims, {'config': value, 'expectedRevision': value['revision']})

    def stored(self, game=GAME):
        return self.database.rows['games'][games.key('game', game)]

    def configure_model(self, change=None):
        config = self.af.defaults()
        config['revision'] = 1; config['allowPaidExecution'] = True
        model = config['models'][1]; model.update(enabled=True, target='test.fake-model')
        config['agents'][0]['modelId'] = model['id']
        if change: change(config)
        self.write_registry(config)
        self.save_config(lambda value: value.update(assistantModeId='media-coach'))
        return config

    def write_registry(self, config):
        self.database.rows['assistant'][self.af.scoped_key('config')] = {
            'id': self.af.scoped_key('config'), 'revision': config['revision'], 'payload': json.dumps(config),
            'organization_id': ORG, 'service_id': SERVICE}

    def test_default_settings_and_permission_flags(self):
        settings = games.settings(self.api, self.claims)
        self.assertTrue(settings['config']['creationEnabled']); self.assertTrue(settings['canCreate'])
        self.assertTrue(settings['canPublish']); self.assertTrue(settings['canManage'])
        self.claims['permissions'] = ['games-create']
        settings = games.settings(self.api, self.claims)
        self.assertFalse(settings['canPublish']); self.assertFalse(settings['canManage'])
        self.assertFalse(settings['canAdminContent'])

    def test_guided_creation_has_private_chat_and_no_provider(self):
        state = self.create(prompt='a space platformer, collect 12, 90 seconds, 3 lives')
        self.assertEqual(state['spec']['genre'], 'platformer'); self.assertEqual(state['spec']['theme'], 'space')
        self.assertEqual(state['spec']['rules']['goal'], 12); self.assertEqual(state['spec']['rules']['timeLimit'], 90)
        self.assertEqual(state['revision'], 0); self.assertEqual(len(state['messages']), 2)
        self.assertNotIn('_owner', state); self.assertFalse(self.database.rows['published-games'])
        self.provider.converse.assert_not_called()

    def test_guided_conversation_updates_supported_settings_and_explains_limits(self):
        state = self.message(self.create(), 'Call it "Moon Axolotl". Make it hard, 2 minutes, color blue. Add multiplayer and music.')
        spec = state['spec']
        self.assertEqual(spec['title'], 'Moon Axolotl'); self.assertEqual(spec['rules']['difficulty'], 4)
        self.assertEqual(spec['rules']['timeLimit'], 120); self.assertEqual(spec['player']['color'], '#79b9df')
        self.assertIn('cannot add', state['messages'][-1]['text'])
        self.provider.converse.assert_not_called()

    def test_story_language_settings_and_followup_preserve_archetype(self):
        state = self.create(prompt='A pink axolotl collects 20 stars in a pond and avoids rocks.')
        self.assertEqual(state['spec']['theme'], 'pond'); self.assertEqual(state['spec']['rules']['goal'], 20)
        self.assertEqual(state['spec']['objects'], {'collectible': 'star', 'hazard': 'rock'})
        garden = games.guided_spec('A blue axolotl can collect flowers in a garden and avoid thorns.')
        self.assertEqual(garden['theme'], 'garden'); self.assertEqual(garden['player']['color'], '#79b9df')
        self.assertEqual(garden['objects'], {'collectible': 'flower', 'hazard': 'thorn'})
        jumping = games.guided_spec('a platformer')
        followup = games.guided_spec('Make it a space game, collect 5, 30 seconds.', jumping)
        self.assertEqual(followup['genre'], 'platformer'); self.assertEqual(followup['theme'], 'space')

    def test_guided_unknown_and_invalid_numbers_do_not_claim_generation(self):
        state = self.create(); first_spec = deepcopy(state['spec'])
        state = self.message(state, 'tell me a joke')
        self.assertEqual(first_spec, state['spec']); self.assertIn('I can build', state['messages'][-1]['text'])
        state = self.message(state, 'goal 999 and speed 0', SECOND)
        self.assertEqual(state['spec']['rules']['goal'], 10)
        self.assertIn('kept the previous', state['messages'][-1]['text'])

    def test_explicit_game_fields_and_malicious_line_are_bounded(self):
        state = self.create(prompt='Title: Lil Explorer\nPlayer: Tiny\nCollectible: star\nHazard: meteor\nInstructions: Move and collect stars.')
        self.assertEqual(state['spec']['title'], 'Lil Explorer'); self.assertEqual(state['spec']['player']['name'], 'Tiny')
        self.assertEqual(state['spec']['instructions'], 'Move and collect stars.')
        state = self.message(state, 'Title: <script>alert(1)</script>')
        self.assertEqual(state['spec']['title'], 'Lil Explorer')
        self.assertIn('plain text', state['messages'][-1]['text'])

    def test_strict_specs_reject_executable_or_remote_inputs(self):
        for value in ['https://example.com', '<script>', 'hello > there', 'fetch (', 'eval(', 'import(', 'data : image', '\x80', '\n', ' leading', 'trailing ']:
            candidate = games.default_spec(); candidate['title'] = value
            self.error(400, lambda: games.validate_spec(candidate))
        for field in ['script', 'assets', 'url', '__proto__']:
            candidate = games.default_spec(); candidate[field] = 'evil'
            self.error(400, lambda: games.validate_spec(candidate))

    def test_spec_numbers_types_bounds_and_nested_keys(self):
        for number in [True, False, float('nan'), float('inf'), 1.0, '5', None, 9]:
            candidate = games.default_spec(); candidate['player']['speed'] = number
            self.error(400, lambda: games.validate_spec(candidate))
        for key in ['version', 'rules', 'objects', 'instructions']:
            candidate = games.default_spec(); candidate.pop(key)
            self.error(400, lambda: games.validate_spec(candidate))
        candidate = games.default_spec(); candidate['player']['code'] = 'run'
        self.error(400, lambda: games.validate_spec(candidate))
        candidate = games.default_spec(); candidate['title'] = 'a' * 81
        self.error(400, lambda: games.validate_spec(candidate))
        candidate = games.default_spec(); candidate['title'] = '🐟' * 41
        self.error(400, lambda: games.validate_spec(candidate))

    def test_create_retry_is_same_owner_and_same_prompt_only(self):
        first = self.create(); self.assertEqual(self.create(), first)
        self.error(409, lambda: self.create(prompt='different idea'))
        self.claims['sub'] = OTHER
        self.error(409, self.create)

    def test_deleted_identifier_cannot_resurrect_and_stale_edit_fails(self):
        state = self.create(); games.delete(self.api, self.claims, GAME, {'revision': state['revision']})
        self.error(409, self.create)
        self.error(404, lambda: games.update(self.api, self.claims, GAME, {'revision': 0, 'spec': state['spec']}))
        self.assertTrue(json.loads(self.stored()['payload'])['_deleted'])

    def test_private_read_and_edit_is_owner_scoped_but_game_managers_manage_others(self):
        state = self.create(); self.claims.update(sub=OTHER, permissions=['games-create'])
        self.error(404, lambda: games.load(self.api, self.claims, GAME))
        self.error(404, lambda: games.update(self.api, self.claims, GAME, {'revision': state['revision'], 'spec': state['spec']}))
        self.assertEqual(games.list_games(self.api, self.claims, {})['games'], [])
        self.claims['permissions'].append('games-publish')
        self.error(404, lambda: games.load(self.api, self.claims, GAME))
        self.claims['permissions'].append('games-manage')
        self.assertEqual(games.load(self.api, self.claims, GAME)[0]['id'], GAME)
        self.assertEqual(len(games.list_games(self.api, self.claims, {})['games']), 1)
        updated = games.update(self.api, self.claims, GAME, {'revision': state['revision'], 'spec': state['spec']})
        self.assertEqual(updated['revision'], 1); self.assertEqual(self.stored()['owner'], USER)

    def test_live_authorization_for_every_protected_dispatch(self):
        for method, path in [('GET', '/games/settings'), ('GET', '/games'), ('POST', '/games'), ('GET', '/games/' + GAME)]:
            self.error(401, lambda: games.dispatch(self.api, {}, method, path, {}))
        self.assertEqual(self.authorization.call_count, 4)
        self.claims['permissions'] = []
        self.assertFalse(games.dispatch(self.api, self.event(), 'GET', '/games/settings', {})['canCreate'])
        self.error(403, lambda: games.dispatch(self.api, self.event(), 'POST', '/games', {'id': COPY, 'prompt': 'A game'}))

    def test_game_public_routes_do_not_authorize_or_include_private_fields(self):
        state = self.publish(self.finish_test(self.create()))
        self.authorization.reset_mock()
        result = games.dispatch(self.api, {}, 'GET', '/games/published/' + GAME, {})
        self.assertEqual(result['spec'], state['spec']); self.assertEqual(result['status'], 'Published')
        self.assertNotIn('messages', result); self.assertNotIn('testedRevision', result)
        self.assertFalse(any(key.startswith('_') for key in result))
        listing = games.dispatch(self.api, {}, 'GET', '/games/published', {})
        self.assertEqual(listing['games'], [result]); self.authorization.assert_not_called()

    def test_publishing_requires_exact_tested_revision_and_publish_permission(self):
        state = self.create(); self.error(409, lambda: self.publish(state))
        state = self.finish_test(state)
        self.assertEqual(state['testedRevision'], state['revision'])
        self.claims['permissions'] = ['games-create']; self.error(403, lambda: self.publish(state))
        self.claims['permissions'].append('games-publish')
        published = self.publish(state)
        self.assertEqual(published['publishedRevision'], published['revision'])

    def test_edit_invalidates_test_and_public_copy_remains_unchanged(self):
        published = self.publish(self.finish_test(self.create()))
        candidate = deepcopy(published['spec']); candidate['title'] = 'A private change'
        edited = games.update(self.api, self.claims, GAME, {'revision': published['revision'], 'spec': candidate})
        self.assertNotIn('testedRevision', edited); self.error(409, lambda: self.publish(edited))
        public = games.dispatch(self.api, {}, 'GET', '/games/published/' + GAME, {})
        self.assertEqual(public['spec']['title'], published['spec']['title'])

    def test_stale_mutations_are_rejected(self):
        state = self.create(); changed = self.message(state)
        for fn in [lambda: self.finish_test(state), lambda: games.update(self.api, self.claims, GAME, {'revision': 0, 'spec': state['spec']}),
            lambda: games.delete(self.api, self.claims, GAME, {'revision': 0}),
            lambda: games.duplicate(self.api, self.claims, GAME, {'revision': 0, 'id': COPY})]:
            self.error(409, fn)
        self.assertEqual(games.load(self.api, self.claims, GAME)[0]['revision'], changed['revision'])

    def test_admin_can_disable_creation_and_reenable_with_cas(self):
        state = self.create(); config = self.save_config(lambda value: value.update(creationEnabled=False))['config']
        self.assertEqual(config['revision'], 1)
        self.error(409, lambda: games.put_config(self.api, self.claims, {'config': config, 'expectedRevision': 0}))
        self.claims['permissions'] = ['games-create']
        self.error(403, lambda: games.put_config(self.api, self.claims, {'config': config, 'expectedRevision': 1}))
        self.assertEqual(games.load(self.api, self.claims, GAME)[0]['id'], state['id'])

    def test_off_switch_blocks_all_authoring_and_publishing_but_allows_cleanup(self):
        state = self.publish(self.finish_test(self.create()))
        state = self.finish_test(state)
        self.save_config(lambda value: value.update(creationEnabled=False))
        for fn in [lambda: self.create(COPY), lambda: self.message(state),
            lambda: games.update(self.api, self.claims, GAME, {'revision': state['revision'], 'spec': state['spec']}),
            lambda: games.duplicate(self.api, self.claims, GAME, {'revision': state['revision'], 'id': COPY}), lambda: self.publish(state)]:
            self.error(403, fn)
        self.assertEqual(len(games.dispatch(self.api, {}, 'GET', '/games/published', {})['games']), 1)
        state = self.finish_test(state)
        state = games.publication(self.api, self.claims, GAME, {'revision': state['revision']}, False)
        self.assertEqual(state['status'], 'Draft'); self.assertFalse(self.database.rows['published-games'])
        games.delete(self.api, self.claims, GAME, {'revision': state['revision']})

    def test_owner_can_delete_unpublished_draft_when_creation_off(self):
        state = self.create(); self.save_config(lambda value: value.update(creationEnabled=False))
        self.claims['permissions'] = ['games-create']
        self.assertEqual(games.delete(self.api, self.claims, GAME, {'revision': state['revision']}), {'removed': True})

    def test_owner_cannot_delete_live_game_without_publish_permission(self):
        state = self.publish(self.finish_test(self.create())); self.claims['permissions'] = ['games-create']
        self.error(403, lambda: games.delete(self.api, self.claims, GAME, {'revision': state['revision']}))
        self.assertTrue(self.database.rows['published-games'])

    def test_duplicate_is_private_untested_and_does_not_copy_conversation(self):
        state = self.publish(self.finish_test(self.create()))
        copy = games.duplicate(self.api, self.claims, GAME, {'revision': state['revision'], 'id': COPY})
        self.assertEqual(copy['status'], 'Draft'); self.assertEqual(copy['messages'], [])
        self.assertNotIn('testedRevision', copy); self.assertNotIn('publishedRevision', copy)
        self.assertEqual(copy['spec']['title'], 'Copy of ' + state['spec']['title'])
        self.assertEqual(len(self.database.rows['published-games']), 1)

    def race_once(self, callback):
        original = self.database.transact
        def racing(TransactItems):
            self.database.meta.client.transact_write_items.side_effect = original
            callback(); return original(TransactItems)
        self.database.meta.client.transact_write_items.side_effect = racing

    def test_absent_default_config_guard_rejects_disable_racing_create(self):
        self.race_once(lambda: self.save_config(lambda value: value.update(creationEnabled=False)))
        self.error(409, self.create)
        self.assertNotIn(games.key('game', GAME), self.database.rows['games'])

    def test_existing_config_guard_rejects_disable_racing_save(self):
        state = self.create(); self.save_config(lambda _: None)
        self.race_once(lambda: self.save_config(lambda value: value.update(creationEnabled=False)))
        self.error(409, lambda: games.update(self.api, self.claims, GAME, {'revision': state['revision'], 'spec': state['spec']}))
        self.assertEqual(games.load(self.api, self.claims, GAME)[0]['revision'], 0)

    def test_stale_publication_cannot_override_concurrent_edit(self):
        state = self.finish_test(self.create())
        self.race_once(lambda: games.update(self.api, self.claims, GAME, {'revision': state['revision'], 'spec': state['spec']}))
        self.error(409, lambda: self.publish(state))
        self.assertFalse(self.database.rows['published-games'])

    def test_scope_checks_and_public_scans_filter_other_orgs(self):
        self.publish(self.finish_test(self.create()))
        foreign = next(iter(self.database.rows['published-games'].values()))
        foreign['organization_id'] = OTHER
        self.assertEqual(games.list_games(self.api, None, {}, True)['games'], [])
        self.error(404, lambda: games.dispatch(self.api, {}, 'GET', '/games/published/' + GAME, {}))

    def test_cursor_validation_and_single_page_continuation(self):
        state = self.create()
        for cursor in ['garbage', '{}', 'A' * 1001]:
            self.error(400, lambda: games.list_games(self.api, self.claims, {'queryStringParameters': {'cursor': cursor}}))
        original = self.database.Table
        class Page:
            def scan(self, **options): return {'Items': [], 'LastEvaluatedKey': {'id': games.key('game', GAME)}}
        with patch.object(self.database, 'Table', return_value=Page()):
            result = games.list_games(self.api, self.claims, {})
        self.assertIn('cursor', result)
        self.assertEqual(games.list_games(self.api, self.claims, {'queryStringParameters': {'cursor': result['cursor']}})['games'][0]['id'], state['id'])

    def test_scan_cursor_can_end_on_settings_or_foreign_scope_without_leaking(self):
        import base64
        self.create()
        for last_id in [games.key('game-config'), 'game:' + OTHER + ':' + SERVICE + ':' + COPY,
                'game-config:' + OTHER + ':' + SERVICE + ':']:
            cursor = base64.urlsafe_b64encode(json.dumps({'id': last_id}).encode()).decode()
            result = games.list_games(self.api, self.claims, {'queryStringParameters': {'cursor': cursor}})
            self.assertEqual(len(result['games']), 1)
            self.assertEqual(result['games'][0]['id'], GAME)

    def test_local_configured_mode_registry_revoke_race_rejects_free_chat(self):
        registry = self.af.defaults()
        self.write_registry(registry)
        self.save_config(lambda value: value.update(assistantModeId='media-coach'))
        state = self.create()
        def revoke():
            registry['revision'] += 1; registry['enabled'] = False; self.write_registry(registry)
        self.race_once(revoke)
        self.error(409, lambda: self.message(state))
        self.provider.converse.assert_not_called()
        self.assertEqual(games.load(self.api, self.claims, GAME)[0]['revision'], 0)

    def test_message_request_idempotency_and_content_binding(self):
        state = self.create(); changed = self.message(state)
        self.assertEqual(self.message(state), changed)
        self.error(409, lambda: self.message(state, 'different message'))
        self.assertEqual(len(changed['messages']), 4)

    def test_paid_creation_is_free_and_explicit_followup_requires_saved_authorization(self):
        self.configure_model(lambda config: config.update(allowPaidExecution=False))
        state = self.create(); self.provider.converse.assert_not_called()
        self.error(403, lambda: self.message(state)); self.provider.converse.assert_not_called()
        self.assertEqual(games.load(self.api, self.claims, GAME)[0]['revision'], 0)

    def test_optional_mode_audience_and_model_disable_are_enforced(self):
        registry = self.configure_model()
        state = self.create()
        registry['modes'][0]['audience'] = {'allEditors': False, 'userIds': [OTHER]}; registry['revision'] += 1
        self.write_registry(registry); self.error(403, lambda: self.message(state))
        registry['modes'][0]['audience']['userIds'] = [USER]; registry['models'][1]['enabled'] = False; registry['revision'] += 1
        self.write_registry(registry); self.error(403, lambda: self.message(state))
        self.provider.converse.assert_not_called()

    def test_paid_receipt_precedes_provider_io_and_success_retries_no_charge(self):
        self.configure_model(); state = self.create()
        def respond(**kwargs):
            stored = json.loads(self.stored()['payload'])
            self.assertEqual(stored['_pending']['id'], REQUEST)
            self.assertEqual(stored['_requests'][-1]['status'], 'pending')
            return {'output': {'message': {'content': [{'text': json.dumps({'text': 'Updated.', 'spec': deepcopy(state['spec'])})}]}}}
        self.provider.converse.side_effect = respond
        changed = self.message(state)
        self.assertEqual(changed['revision'], 2); self.assertNotIn('operationState', changed)
        self.assertEqual(self.message(state), changed); self.provider.converse.assert_called_once()

    def test_uncertain_paid_request_never_replays_and_manual_edit_can_recover(self):
        self.configure_model(); state = self.create(); self.provider.converse.side_effect = TimeoutError()
        self.error(503, lambda: self.message(state)); self.error(409, lambda: self.message(state))
        self.provider.converse.assert_called_once()
        pending = games.private_output(games.load(self.api, self.claims, GAME)[0])
        self.assertIn('operationState', pending)
        self.error(409, lambda: self.finish_test(pending))
        edited = games.update(self.api, self.claims, GAME, {'revision': pending['revision'], 'spec': pending['spec']})
        self.assertNotIn('operationState', edited)

    def test_malicious_model_spec_cannot_publish_or_inject_executable_content(self):
        self.configure_model(); state = self.create(); candidate = games.default_spec(); candidate['script'] = 'fetch(secret)'
        self.provider.converse.return_value = {'output': {'message': {'content': [{'text': json.dumps({'text': 'Run this', 'spec': candidate})}]}}}
        self.error(400, lambda: self.message(state)); self.error(409, lambda: self.message(state))
        self.provider.converse.assert_called_once(); self.assertFalse(self.database.rows['published-games'])

    def test_revoke_paid_authorization_during_provider_prevents_commit(self):
        registry = self.configure_model(); state = self.create()
        def respond(**kwargs):
            registry['allowPaidExecution'] = False; registry['revision'] += 1; self.write_registry(registry)
            return {'output': {'message': {'content': [{'text': json.dumps({'text': 'Updated.', 'spec': deepcopy(state['spec'])})}]}}}
        self.provider.converse.side_effect = respond
        self.error(403, lambda: self.message(state))
        pending, _ = games.load(self.api, self.claims, GAME)
        self.assertIn('_pending', pending); self.assertEqual(pending['revision'], 1)

    def test_disable_creation_during_provider_prevents_commit(self):
        self.configure_model(); state = self.create()
        def respond(**kwargs):
            self.save_config(lambda config: config.update(creationEnabled=False))
            return {'output': {'message': {'content': [{'text': json.dumps({'text': 'Updated.', 'spec': deepcopy(state['spec'])})}]}}}
        self.provider.converse.side_effect = respond
        self.error(409, lambda: self.message(state))
        self.assertEqual(games.load(self.api, self.claims, GAME)[0]['revision'], 1)

    def test_ownership_permission_revocation_during_paid_call_prevents_commit(self):
        self.configure_model(); state = self.create(); self.claims['sub'] = OTHER
        def respond(**kwargs):
            self.claims['permissions'] = ['games-create']
            return {'output': {'message': {'content': [{'text': json.dumps({'text': 'Updated.', 'spec': deepcopy(state['spec'])})}]}}}
        self.provider.converse.side_effect = respond
        self.error(403, lambda: self.message(state))

    def test_manual_edit_racing_provider_completion_wins_without_overwrite(self):
        self.configure_model(); state = self.create()
        def respond(**kwargs):
            pending = games.load(self.api, self.claims, GAME)[0]
            candidate = deepcopy(pending['spec']); candidate['title'] = 'Human wins'
            games.update(self.api, self.claims, GAME, {'revision': pending['revision'], 'spec': candidate})
            return {'output': {'message': {'content': [{'text': json.dumps({'text': 'Updated.', 'spec': deepcopy(state['spec'])})}]}}}
        self.provider.converse.side_effect = respond
        self.error(409, lambda: self.message(state))
        self.assertEqual(games.load(self.api, self.claims, GAME)[0]['spec']['title'], 'Human wins')

    def test_handler_lazy_dispatch_and_preflight_remain_independent(self):
        handler._games = games
        with patch.object(handler, 'authorize', side_effect=self.authorize), patch.object(handler, 'clients', self.api.clients):
            event = {**self.event(), 'rawPath': '/games/settings', 'requestContext': {'http': {'method': 'GET'}}}
            response = handler.handler(event, None)
            self.assertEqual(response['statusCode'], 200); self.assertIn('canCreate', json.loads(response['body']))
            event = {'rawPath': '/games/published', 'requestContext': {'http': {'method': 'OPTIONS'}}}
            self.assertEqual(handler.handler(event, None)['statusCode'], 204)


if __name__ == '__main__': unittest.main()
