"""Offline word-search suggestions. Every provider is mocked; sockets are blocked."""
from copy import deepcopy
import json
import socket
import unittest
from unittest.mock import patch

import test_games as support

games = support.games


class WordSearchSuggestionsTests(unittest.TestCase):
    authorize = support.GameTests.authorize
    event = support.GameTests.event
    error = support.GameTests.error
    create = support.GameTests.create
    message = support.GameTests.message
    publish = support.GameTests.publish
    finish_test = support.GameTests.finish_test
    stored = support.GameTests.stored
    save_config = support.GameTests.save_config
    write_registry = support.GameTests.write_registry
    race_once = support.GameTests.race_once

    def setUp(self):
        support.GameTests.setUp(self)
        for name in ('socket', 'create_connection'):
            blocked = patch.object(socket, name, side_effect=AssertionError('Offline tests cannot access a network.'))
            blocked.start(); self.addCleanup(blocked.stop)
        self.words = ['MOON', 'MARS', 'STAR', 'ORBIT', 'COMET', 'ROCKET']
        self.provider.converse.return_value = self.response()

    def response(self, words=None):
        return {'stopReason': 'end_turn', 'output': {'message': {'content': [{'text': json.dumps({'words': self.words if words is None else words})}]}}}

    def configure(self, change=None):
        registry = self.af.defaults()
        registry['revision'] = 1; registry['allowPaidExecution'] = True
        registry['models'][1].update(enabled=True, target='test.small-model', maxOutputTokens=1800)
        registry['agents'][0]['modelId'] = registry['models'][1]['id']
        if change: change(registry)
        self.write_registry(registry)
        self.save_config(lambda value: value.update(wordSearchAssistantModeId='media-coach'))
        return registry

    def search(self, identifier=support.GAME):
        return self.create(identifier, 'A word search about nature')

    def body(self, game, request=support.REQUEST, path=None):
        path = [] if path is None else path
        target = games.word_search_at_path(game['spec'], path)
        return {'revision': game['revision'], 'requestId': request, 'path': path,
            'title': target['title'], 'description': target['description']}

    def suggest(self, game, request=support.REQUEST, path=None, body=None):
        return games.dispatch(self.api, self.event(), 'POST', '/games/' + game['id'] + '/word-search-suggestions',
            self.body(game, request, path) if body is None else body)

    def model_content(self, content, target=None):
        self.provider.converse.return_value = {'stopReason': 'end_turn', 'output': {'message': {'content': [{'text': content}]}}}
        return games.word_search_model_words(self.af, {'instructions': 'Use familiar words.'},
            {'target': 'test.small-model', 'maxOutputTokens': 1800}, target or games.word_games().default_spec('word-search'))

    def test_old_settings_and_independent_optional_modes_are_preserved(self):
        old = games.config_defaults()
        self.assertEqual(games.validate_config(old), old)
        for optional in ({'crosswordAssistantModeId': ''}, {'wordSearchAssistantModeId': ''},
                {'crosswordAssistantModeId': 'crossword-mode', 'wordSearchAssistantModeId': 'search-mode'}):
            self.assertEqual(games.validate_config({**old, **optional}), {**old, **optional})
        for invalid in (None, [], 'UPPER', 'with space'):
            self.error(400, lambda: games.validate_config({**old, 'wordSearchAssistantModeId': invalid}))
        self.assertFalse(games.settings(self.api, self.claims)['wordSearchGenerator']['available'])
        self.error(403, lambda: self.suggest(self.search()))
        self.provider.converse.assert_not_called()

    def test_dedicated_generator_does_not_enable_crossword_or_paid_conversation(self):
        self.configure(); settings = games.settings(self.api, self.claims)
        self.assertEqual(settings['config']['assistantModeId'], '')
        self.assertNotIn('crosswordAssistantModeId', settings['config'])
        self.assertFalse(settings['crosswordGenerator']['available'])
        self.assertEqual(settings['wordSearchGenerator'], {'available': True, 'modeName': 'Media coach', 'modelName': 'Amazon Bedrock writer'})
        self.message(self.search(), 'Title: Free title')
        self.provider.converse.assert_not_called()

    def test_creator_permission_and_owner_scope_are_required(self):
        self.configure(); game = self.search()
        self.claims['permissions'] = ['games-play']
        self.error(403, lambda: self.suggest(game))
        self.assertFalse(games.settings(self.api, self.claims)['wordSearchGenerator']['available'])
        self.claims.update(sub=support.OTHER, permissions=['games-create'])
        self.error(404, lambda: self.suggest(game))
        self.provider.converse.assert_not_called()

    def test_paid_switch_audience_model_workflow_and_creation_controls_precede_billing(self):
        self.configure(); game = self.search(); initial = deepcopy(self.stored())
        for change in (
                lambda registry: registry.update(allowPaidExecution=False),
                lambda registry: registry.update(enabled=False),
                lambda registry: registry['models'][1].update(enabled=False),
                lambda registry: registry['workflows'][0].update(enabled=False),
                lambda registry: registry['modes'][0].update(audience={'allEditors': False, 'userIds': [support.OTHER]}),
                lambda registry: registry['limits'].update(maxModelCalls=0)):
            registry = self.af.defaults(); registry['allowPaidExecution'] = True
            registry['models'][1].update(enabled=True, target='test.small-model')
            registry['agents'][0]['modelId'] = registry['models'][1]['id']; change(registry)
            self.write_registry(registry)
            self.assertFalse(games.settings(self.api, self.claims)['wordSearchGenerator']['available'])
            self.error(403, lambda: self.suggest(game))
            self.assertEqual(self.stored(), initial)
        self.configure(); self.save_config(lambda value: value.update(creationEnabled=False))
        self.error(403, lambda: self.suggest(game))
        self.provider.converse.assert_not_called()

    def test_local_model_and_insufficient_output_budget_do_not_fallback(self):
        for change in (lambda registry: registry['agents'][0].update(modelId='local-coach'),
                lambda registry: registry['models'][1].update(maxOutputTokens=255)):
            self.error(403, lambda: self.configure(change))
        self.configure(lambda registry: registry['models'][1].update(maxOutputTokens=256))
        self.suggest(self.search())
        self.assertEqual(self.provider.converse.call_args.kwargs['inferenceConfig']['maxTokens'], 256)

    def test_exact_saved_revision_title_description_and_target_are_bound(self):
        self.configure(); game = self.search()
        for updates, status in (({'revision': 1}, 409), ({'title': 'Unsaved title'}, 409),
                ({'description': 'Unsaved description'}, 409), ({'path': ['step-1']}, 409),
                ({'path': ['step-13']}, 400), ({'path': ['step-1', 'step-2']}, 400),
                ({'path': 'step-1'}, 400), ({'title': '<script>'}, 400), ({'extra': True}, 400)):
            self.error(status, lambda: self.suggest(game, body={**self.body(game), **updates}))
        other = self.create(support.COPY, 'A crossword about nature')
        body = {**self.body(game), 'title': other['spec']['title'], 'description': other['spec']['description']}
        self.error(409, lambda: self.suggest(other, body=body))
        self.provider.converse.assert_not_called()

    def test_success_reserves_before_io_and_does_not_change_any_game_fields(self):
        self.configure(); game = self.finish_test(self.search())
        before = deepcopy(game)
        def respond(**kwargs):
            pending = json.loads(self.stored()['payload'])
            self.assertEqual(pending['_pending']['id'], support.REQUEST)
            self.assertEqual(pending['_requests'][-1]['status'], 'pending')
            self.assertEqual(pending['_modelCalls'], 1); self.assertEqual(pending['_turns'], 1)
            self.assertEqual(pending['spec'], before['spec'])
            return self.response()
        self.provider.converse.side_effect = respond
        result = self.suggest(game)
        self.assertEqual(result['game']['revision'], game['revision'] + 2)
        self.assertEqual(result['game']['spec'], before['spec'])
        self.assertEqual(result['game']['messages'], before['messages'])
        self.assertNotIn('testedRevision', result['game']); self.assertNotIn('operationState', result['game'])
        self.assertEqual(result['proposal'], {**{key: self.body(game)[key] for key in ('requestId', 'path', 'title', 'description')}, 'words': self.words})
        self.assertNotIn('_wordSearchSuggestions', result['game'])
        self.assertEqual(json.loads(self.stored()['payload'])['_wordSearchSuggestions'][support.REQUEST], result['proposal'])
        self.assertFalse(self.database.rows['published-games'])

    def test_cached_retry_is_content_bound_and_never_bills_again(self):
        self.configure(); game = self.search(); result = self.suggest(game)
        self.assertEqual(self.suggest(game), result)
        self.error(409, lambda: self.suggest(game, body={**self.body(game), 'description': 'Different topic'}))
        self.provider.converse.assert_called_once()
        changed_spec = deepcopy(result['game']['spec']); changed_spec['title'] = 'A later edit'
        changed = games.update(self.api, self.claims, game['id'], {'revision': result['game']['revision'], 'spec': changed_spec})
        retry = self.suggest(game)
        self.assertEqual(retry['proposal'], result['proposal']); self.assertEqual(retry['game'], changed)
        self.provider.converse.assert_called_once()

    def test_request_kinds_do_not_collide_with_crossword_or_conversation(self):
        self.configure(); game = self.search(); result = self.suggest(game)
        # The body is byte-identical; only the protected operation kind differs.
        self.error(409, lambda: games.crossword_suggestions(self.api, self.claims, game['id'], self.body(game), self.event()))
        self.error(409, lambda: self.message(result['game'], 'Title: Another title', support.REQUEST))
        self.provider.converse.assert_called_once()
        other = self.search(support.COPY); chatted = self.message(other, 'Title: Free chat', support.SECOND)
        self.error(409, lambda: self.suggest(chatted, support.SECOND))
        self.provider.converse.assert_called_once()

    def test_uncertain_timeout_cannot_replay_and_manual_recovery_preserves_receipt(self):
        self.configure(); game = self.search(); self.provider.converse.side_effect = TimeoutError()
        self.error(503, lambda: self.suggest(game)); self.error(409, lambda: self.suggest(game))
        pending = games.private_output(games.load(self.api, self.claims, game['id'])[0])
        self.assertEqual(pending['operationState'], 'pending')
        self.error(409, lambda: self.suggest(pending, support.SECOND))
        recovered = games.update(self.api, self.claims, game['id'], {'revision': pending['revision'], 'spec': pending['spec']})
        self.assertNotIn('operationState', recovered)
        self.error(409, lambda: self.suggest(game))
        self.provider.converse.assert_called_once()

    def test_pending_generation_blocks_the_other_genre_on_a_valid_sibling(self):
        self.configure(); self.save_config(lambda value: value.update(crosswordAssistantModeId='media-coach'))
        self.provider.converse.side_effect = TimeoutError()
        for identifier, first_crossword in ((support.GAME, True), (support.COPY, False)):
            game = self.create(identifier, 'Create a multi-game journey')
            first_index, other_index = (0, 1) if first_crossword else (1, 0)
            def send(state, index, request):
                target = state['spec']['steps'][index]
                body = {'revision': state['revision'], 'requestId': request, 'path': [target['id']],
                    'title': target['spec']['title'], 'description': target['spec']['description']}
                action = 'crossword-suggestions' if index == 0 else 'word-search-suggestions'
                return games.dispatch(self.api, self.event(), 'POST', '/games/' + state['id'] + '/' + action, body)
            self.error(503, lambda: send(game, first_index, support.REQUEST))
            pending = games.private_output(games.load(self.api, self.claims, identifier)[0])
            calls = self.provider.converse.call_count
            self.error(409, lambda: send(pending, other_index, support.SECOND))
            self.assertEqual(self.provider.converse.call_count, calls)

    def test_prompt_has_only_saved_topic_and_bounded_output_without_identity_or_history(self):
        self.configure(); game = self.search(); self.suggest(game)
        call = self.provider.converse.call_args.kwargs
        self.assertEqual(call['modelId'], 'test.small-model')
        self.assertEqual(call['inferenceConfig'], {'maxTokens': 512, 'temperature': 0.3})
        self.assertEqual(json.loads(call['messages'][0]['content'][0]['text']), {'title': game['spec']['title'], 'description': game['spec']['description']})
        for secret in (support.USER, support.ORG, support.SERVICE, 'Bearer current', game['messages'][0]['text']):
            self.assertNotIn(secret, json.dumps(call))
        self.assertNotIn('toolConfig', call)
        self.assertIn('untrusted topic data', call['system'][0]['text'])

    def test_normalization_accepts_only_one_json_envelope_and_simple_ascii_separators(self):
        words = ['m o o n', 'm-a-r-s', 'star']
        for content in (json.dumps({'words': words}), '```json\n' + json.dumps({'words': words}) + '\n```',
                '```\n' + json.dumps({'words': words}) + '\n```'):
            self.assertEqual(self.model_content(content), ['MOON', 'MARS', 'STAR'])
        for bad in (' moon', 'moon ', 'moon--star', 'moon  star', 'moon- star', 'moon_star', 'moon/star',
                'https://example.test', 'fetch(secret)', 'm\u2014oon', 'm\u00a0oon', '\uff2d\uff2f\uff2f\uff2e', 'A' * 36, 'A' * 19, 'A'):
            with self.assertRaises(games.GameError): self.model_content(json.dumps({'words': [bad, 'MARS', 'STAR']}))

    def test_malformed_json_schema_unsafe_words_duplicates_and_oversized_pools_are_not_salvaged(self):
        long_unique = ['A' * 17 + chr(letter) for letter in range(ord('B'), ord('P'))]
        invalid_contents = [
            'DO_NOT_LOG_THIS ' + json.dumps({'words': self.words}),
            '```javascript\n' + json.dumps({'words': self.words}) + '\n```',
            '```json\n' + json.dumps({'words': self.words}) + '\n```\nDO_NOT_LOG_THIS',
            '{"words":[],"words":[]}', '{"words":NaN}',
            json.dumps({'words': self.words, 'code': 'DO_NOT_LOG_THIS'}),
            json.dumps({'words': ['MOON', 'M O O N', 'STAR']}),
            json.dumps({'words': [{'answer': 'MOON'}, 'MARS', 'STAR']}),
            json.dumps({'words': [*self.words, 'https://DO_NOT_LOG_THIS.example']}),
            json.dumps({'words': self.words[:2]}), json.dumps({'words': ['AB' + chr(letter) for letter in range(65, 90)]}),
            json.dumps({'words': long_unique}),
        ]
        for content in invalid_contents:
            with self.assertRaises(games.GameError) as caught: self.model_content(content)
            self.assertEqual(caught.exception.status, 502)
            self.assertNotIn('DO_NOT_LOG_THIS', caught.exception.message)

    def test_bounded_fitting_preserves_grid_seed_directions_and_model_order(self):
        pool = ['ABCDEFGHIJK', *['WORD' + chr(letter) for letter in range(65, 88)]]
        for size, backwards in ((10, False), (24, True)):
            target = games.word_games().default_spec('word-search')
            target['puzzle'].update(size=size, allowBackwards=backwards, seed=4242)
            before = deepcopy(target)
            selected = games.fit_word_search_words(target, pool)
            expected = [word for word in pool if len(word) <= size][:min(16, size)]
            self.assertEqual(selected, expected); self.assertEqual(target, before)
            candidate = deepcopy(target); candidate['puzzle']['words'] = selected
            self.assertEqual(games.validate_spec(candidate), candidate)
            layout = games.word_games().word_search(candidate)
            self.assertEqual({entry['word'] for entry in layout['placements']}, set(selected))
        with self.assertRaises(games.GameError) as caught:
            games.fit_word_search_words({**target, 'puzzle': {**target['puzzle'], 'size': 10}}, ['ABCDEFGHIJK', 'MOON', 'STAR'])
        self.assertIn('saved grid', caught.exception.message)

    def test_entire_pool_is_checked_before_dropping_long_or_excess_words(self):
        target = games.word_games().default_spec('word-search')
        target['puzzle']['size'] = 10
        for tail in ('https://DO_NOT_LOG_THIS.example', 'fetch(DO_NOT_LOG_THIS)', 'MOON'):
            pool = [*self.words, tail]
            with patch.object(games.word_games(), 'word_search', side_effect=AssertionError('Unsafe pools cannot reach fitting.')):
                with self.assertRaises(games.GameError): games.fit_word_search_words(target, pool)

    def test_incomplete_tool_and_oversized_response_leave_an_uncertain_receipt(self):
        self.configure()
        for index, response in enumerate((
                {'stopReason': 'max_tokens', 'output': {'message': {'content': [{'text': '{}'}]}}},
                {'stopReason': 'tool_use', 'output': {'message': {'content': [{'toolUse': {'name': 'fetch'}}]}}},
                {'stopReason': 'end_turn', 'output': {'message': {'content': [{'text': ' ' * 6001}]}}})):
            game = self.search(f'{index + 20:08x}-1111-4111-8111-111111111111')
            self.provider.converse.return_value = response
            self.error(502, lambda: self.suggest(game)); self.error(409, lambda: self.suggest(game))
            state = games.load(self.api, self.claims, game['id'])[0]
            self.assertEqual(state['spec'], game['spec']); self.assertIn('_pending', state)
            self.assertNotIn('_wordSearchSuggestions', state)
        self.assertEqual(self.provider.converse.call_count, 3)

    def test_call_turn_input_and_storage_limits_precede_any_model_call(self):
        registry = self.configure(); game = self.search()
        for field, value in (('_modelCalls', registry['limits']['maxModelCalls']), ('_turns', registry['limits']['maxTurns'])):
            state = json.loads(self.stored()['payload']); state[field] = value
            self.database.rows['games'][games.key('game', game['id'])] = games.envelope('game', state, support.USER)
            self.error(403, lambda: self.suggest(game))
            state[field] = 0
            self.database.rows['games'][games.key('game', game['id'])] = games.envelope('game', state, support.USER)
        registry['limits']['maxInputChars'] = 100; self.write_registry(registry)
        spec = deepcopy(game['spec']); spec['description'] = 'A' * 101
        game = games.update(self.api, self.claims, game['id'], {'revision': game['revision'], 'spec': spec})
        self.error(403, lambda: self.suggest(game))
        registry['limits']['maxInputChars'] = 6000; self.write_registry(registry)
        state = json.loads(self.stored()['payload']); state['messages'] = [{'text': 'A' * 288000}]
        self.database.rows['games'][games.key('game', game['id'])] = games.envelope('game', state, support.USER)
        self.error(413, lambda: self.suggest(game))
        self.provider.converse.assert_not_called()

    def test_multi_game_generates_only_for_the_selected_saved_word_search(self):
        self.configure(); game = self.create(prompt='Create a multi-game journey')
        before = deepcopy(game['spec'])
        result = self.suggest(game, path=['step-2'])
        self.assertEqual(result['game']['spec'], before)
        self.assertEqual(result['proposal']['path'], ['step-2'])
        for path in ([], ['step-1'], ['step-3']):
            self.error(409, lambda: self.suggest(result['game'], body={**self.body(result['game'], support.SECOND, ['step-2']), 'path': path}))
        self.provider.converse.assert_called_once()

    def test_config_and_registry_cas_races_prevent_billing(self):
        registry = self.configure(); game = self.search()
        def revoke():
            registry['revision'] += 1; registry['allowPaidExecution'] = False; self.write_registry(registry)
        self.race_once(revoke)
        self.error(409, lambda: self.suggest(game))
        self.assertEqual(games.load(self.api, self.claims, game['id'])[0]['revision'], game['revision'])
        self.provider.converse.assert_not_called()

    def test_live_policy_permission_and_creation_revocation_discards_provider_suggestions(self):
        for kind in ('registry', 'permission', 'creation'):
            self.claims['permissions'] = ['games-create', 'games-manage', 'agents-manage']
            registry = self.configure()
            identifier = {'registry': support.GAME, 'permission': support.COPY, 'creation': support.SECOND}[kind]
            game = self.search(identifier)
            def respond(**kwargs):
                if kind == 'registry':
                    registry['revision'] += 1; registry['allowPaidExecution'] = False; self.write_registry(registry)
                elif kind == 'permission': self.claims['permissions'] = []
                else: self.save_config(lambda value: value.update(creationEnabled=False))
                return self.response()
            self.provider.converse.side_effect = respond
            self.error(409 if kind == 'creation' else 403, lambda: self.suggest(game))
            state = json.loads(self.stored(identifier)['payload'])
            self.assertEqual(state['spec'], game['spec']); self.assertIn('_pending', state)
            self.assertNotIn('_wordSearchSuggestions', state)
        self.assertEqual(self.provider.converse.call_count, 3)

    def test_manual_edit_during_generation_wins_without_overwrite(self):
        self.configure(); game = self.search()
        def respond(**kwargs):
            pending = games.load(self.api, self.claims, game['id'])[0]
            spec = deepcopy(pending['spec']); spec['puzzle']['allowBackwards'] = not spec['puzzle']['allowBackwards']
            games.update(self.api, self.claims, game['id'], {'revision': pending['revision'], 'spec': spec})
            return self.response()
        self.provider.converse.side_effect = respond
        self.error(409, lambda: self.suggest(game))
        state = games.load(self.api, self.claims, game['id'])[0]
        self.assertNotEqual(state['spec']['puzzle']['allowBackwards'], game['spec']['puzzle']['allowBackwards'])
        self.assertNotIn('_wordSearchSuggestions', state)

    def test_proposals_stay_private_and_public_play_and_lookup_never_call_models(self):
        self.configure(); game = self.publish(self.finish_test(self.search()))
        public_before = deepcopy(self.database.rows['published-games'])
        result = self.suggest(game)
        self.assertEqual(self.database.rows['published-games'], public_before)
        copied = games.duplicate(self.api, self.claims, game['id'], {'revision': result['game']['revision'], 'id': support.COPY})
        self.assertNotIn('_wordSearchSuggestions', json.loads(self.stored(support.COPY)['payload']))
        self.assertEqual(copied['status'], 'Draft')
        published = self.publish(self.finish_test(result['game']))
        self.assertNotIn('_wordSearchSuggestions', published)
        self.provider.converse.reset_mock()
        snapshot = games.dispatch(self.api, {}, 'GET', '/games/published/' + game['id'], {})
        games.dispatch(self.api, {}, 'GET', '/games/published', {})
        games.word_games().word_search(snapshot['spec'])
        self.provider.converse.assert_not_called()
        self.assertEqual(json.loads(self.stored()['payload'])['_modelCalls'], 1)


if __name__ == '__main__': unittest.main()
