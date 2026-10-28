"""Offline creator-only crossword suggestions; every provider is mocked."""
from copy import deepcopy
import json
import socket
import unittest
from unittest.mock import patch

import test_games as support

games = support.games


class CrosswordSuggestionsTests(unittest.TestCase):
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
            blocked = patch.object(socket, name, side_effect=AssertionError('Network is disabled in offline tests.'))
            blocked.start(); self.addCleanup(blocked.stop)
        self.entries = deepcopy(games.word_games().default_spec('crossword', 'space')['puzzle']['entries'])
        self.provider.converse.return_value = self.response()

    def response(self, entries=None):
        return {'stopReason': 'end_turn', 'output': {'message': {'content': [{'text': json.dumps({'entries': self.entries if entries is None else entries})}]}}}

    def configure(self, change=None):
        registry = self.af.defaults()
        registry['revision'] = 1; registry['allowPaidExecution'] = True
        registry['models'][1].update(enabled=True, target='test.small-model', maxOutputTokens=1800)
        registry['agents'][0]['modelId'] = registry['models'][1]['id']
        if change: change(registry)
        self.write_registry(registry)
        self.save_config(lambda value: value.update(crosswordAssistantModeId='media-coach'))
        return registry

    def crossword(self):
        return self.create(prompt='A crossword about nature')

    def body(self, game, request=support.REQUEST, path=None):
        path = [] if path is None else path
        target = games.crossword_at_path(game['spec'], path)
        return {'revision': game['revision'], 'requestId': request, 'path': path,
            'title': target['title'], 'description': target['description']}

    def suggest(self, game, request=support.REQUEST, path=None, body=None):
        return games.dispatch(self.api, self.event(), 'POST', '/games/' + game['id'] + '/crossword-suggestions',
            self.body(game, request, path) if body is None else body)

    def generated_content(self, content):
        self.provider.converse.return_value = {'stopReason': 'end_turn', 'output': {'message': {'content': [{'text': content}]}}}
        return games.crossword_model_entries(self.af, {'instructions': 'Use clear clues.'},
            {'target': 'test.small-model', 'maxOutputTokens': 1200}, games.word_games().default_spec('crossword'))

    def generated_error(self, content, category):
        with self.assertRaises(games.GameError) as caught: self.generated_content(content)
        self.assertEqual(caught.exception.status, 502)
        self.assertIn(category, caught.exception.message)
        self.assertIn('will not be replayed', caught.exception.message)
        self.assertNotIn('DO_NOT_LOG_THIS', caught.exception.message)
        return caught.exception.message

    def test_legacy_settings_remain_valid_and_unconfigured_generator_is_unavailable(self):
        old = games.config_defaults()
        self.assertNotIn('crosswordAssistantModeId', old)
        self.assertEqual(games.validate_config(old), old)
        settings = games.settings(self.api, self.claims)
        self.assertFalse(settings['crosswordGenerator']['available'])
        self.assertIn('select a crossword generator', settings['crosswordGenerator']['reason'])
        self.error(403, lambda: self.suggest(self.crossword()))
        self.provider.converse.assert_not_called()
        for invalid in (None, [], 'UPPER', 'has space'):
            self.error(400, lambda: games.validate_config({**old, 'crosswordAssistantModeId': invalid}))
        self.assertEqual(games.validate_config({**old, 'crosswordAssistantModeId': ''})['crosswordAssistantModeId'], '')

    def test_dedicated_mode_can_be_available_with_free_conversation(self):
        self.configure()
        settings = games.settings(self.api, self.claims)
        self.assertEqual(settings['config']['assistantModeId'], '')
        self.assertEqual(settings['crosswordGenerator'], {'available': True, 'modeName': 'Media coach', 'modelName': 'Amazon Bedrock writer'})
        game = self.crossword(); self.message(game, 'Title: Free title')
        self.provider.converse.assert_not_called()

    def test_generator_requires_creator_permission_and_owner_scope(self):
        self.configure(); game = self.crossword()
        self.claims['permissions'] = ['games-play']
        self.error(403, lambda: self.suggest(game))
        self.assertFalse(games.settings(self.api, self.claims)['crosswordGenerator']['available'])
        self.claims.update(sub=support.OTHER, permissions=['games-create'])
        self.error(404, lambda: self.suggest(game))
        self.provider.converse.assert_not_called()

    def test_saved_paid_authorization_audience_and_creation_switch_are_required(self):
        self.configure(); game = self.crossword()
        initial = deepcopy(self.stored())
        for change in (
                lambda registry: registry.update(allowPaidExecution=False),
                lambda registry: registry.update(enabled=False),
                lambda registry: registry['models'][1].update(enabled=False),
                lambda registry: registry['modes'][0].update(audience={'allEditors': False, 'userIds': [support.OTHER]}),
                lambda registry: registry['limits'].update(maxModelCalls=0)):
            registry = self.af.defaults(); registry['allowPaidExecution'] = True
            registry['models'][1].update(enabled=True, target='test.small-model')
            registry['agents'][0]['modelId'] = registry['models'][1]['id']; change(registry)
            self.write_registry(registry)
            self.assertFalse(games.settings(self.api, self.claims)['crosswordGenerator']['available'])
            self.error(403, lambda: self.suggest(game))
            self.assertEqual(self.stored(), initial)
        self.configure(); self.save_config(lambda value: value.update(creationEnabled=False))
        self.error(403, lambda: self.suggest(game))
        self.provider.converse.assert_not_called()

    def test_local_model_and_too_small_output_are_not_silent_fallbacks(self):
        for update in (lambda registry: registry['agents'][0].update(modelId='local-coach'),
                lambda registry: registry['models'][1].update(maxOutputTokens=511)):
            self.error(403, lambda: self.configure(update))
        self.provider.converse.assert_not_called()

    def test_saved_target_revision_title_and_path_bind_before_any_call(self):
        self.configure(); game = self.crossword()
        for patch_body, status in (({'revision': 1}, 409), ({'title': 'Unsaved title'}, 409),
                ({'description': 'Unsaved description'}, 409), ({'path': ['step-1']}, 409),
                ({'path': ['step-13']}, 400), ({'path': ['step-1', 'step-2']}, 400),
                ({'path': 'step-1'}, 400), ({'title': '<script>'}, 400), ({'extra': 'ignored'}, 400)):
            body = {**self.body(game), **patch_body}
            self.error(status, lambda: self.suggest(game, body=body))
        arcade = self.create(support.COPY)
        body = {**self.body(game), 'title': arcade['spec']['title'], 'description': arcade['spec']['description']}
        self.error(409, lambda: self.suggest(arcade, body=body))
        self.provider.converse.assert_not_called()

    def test_success_reserves_before_io_keeps_spec_and_messages_and_returns_private_proposal(self):
        self.configure(); game = self.finish_test(self.crossword())
        before = deepcopy(game)
        def respond(**kwargs):
            pending = json.loads(self.stored()['payload'])
            self.assertEqual(pending['_pending']['id'], support.REQUEST)
            self.assertEqual(pending['_requests'][-1]['status'], 'pending')
            self.assertEqual(pending['_modelCalls'], 1)
            self.assertEqual(pending['_turns'], 1)
            self.assertEqual(pending['spec'], before['spec'])
            return self.response()
        self.provider.converse.side_effect = respond
        result = self.suggest(game)
        self.assertEqual(result['game']['revision'], game['revision'] + 2)
        self.assertEqual(result['game']['spec'], before['spec'])
        self.assertEqual(result['game']['messages'], before['messages'])
        self.assertNotIn('testedRevision', result['game'])
        self.assertNotIn('operationState', result['game'])
        self.assertEqual(result['proposal'], {**{k: self.body(game)[k] for k in ('requestId', 'path', 'title', 'description')}, 'entries': self.entries})
        self.assertNotIn('_crosswordSuggestions', result['game'])
        self.assertEqual(json.loads(self.stored()['payload'])['_crosswordSuggestions'][support.REQUEST], result['proposal'])
        self.assertFalse(self.database.rows['published-games'])

    def test_completed_retry_returns_cached_proposal_without_new_revision_or_charge(self):
        self.configure(); game = self.crossword()
        first = self.suggest(game)
        self.assertEqual(self.suggest(game), first)
        body = self.body(game); body['description'] = 'Another topic'
        self.error(409, lambda: self.suggest(game, body=body))
        body = self.body(game); body['path'] = ['step-1']
        self.error(409, lambda: self.suggest(game, body=body))
        self.provider.converse.assert_called_once()
        # A lost HTTP reply can still be retrieved after a later manual edit.
        changed_spec = deepcopy(first['game']['spec']); changed_spec['title'] = 'Later edit'
        changed = games.update(self.api, self.claims, game['id'], {'revision': first['game']['revision'], 'spec': changed_spec})
        retry = self.suggest(game)
        self.assertEqual(retry['proposal'], first['proposal']); self.assertEqual(retry['game'], changed)
        self.provider.converse.assert_called_once()

    def test_request_identifiers_cannot_collide_with_conversation_receipts(self):
        self.configure(); game = self.crossword()
        chatted = self.message(game, 'Title: Updated')
        self.error(409, lambda: self.suggest(chatted))
        result = self.suggest(chatted, support.SECOND)
        self.error(409, lambda: self.message(result['game'], 'Title: Other', support.SECOND))
        self.provider.converse.assert_called_once()

    def test_uncertain_timeout_cannot_replay_even_after_manual_recovery(self):
        self.configure(); game = self.crossword(); self.provider.converse.side_effect = TimeoutError()
        self.error(503, lambda: self.suggest(game))
        self.error(409, lambda: self.suggest(game))
        pending = games.private_output(games.load(self.api, self.claims, game['id'])[0])
        self.assertEqual(pending['operationState'], 'pending')
        self.error(409, lambda: self.suggest(pending, support.SECOND))
        recovered = games.update(self.api, self.claims, game['id'], {'revision': pending['revision'], 'spec': pending['spec']})
        self.assertNotIn('operationState', recovered)
        self.error(409, lambda: self.suggest(game))
        self.provider.converse.assert_called_once()

    def test_converse_prompt_is_bounded_data_only_and_contains_no_identity_or_history(self):
        self.configure(); game = self.crossword(); self.suggest(game)
        call = self.provider.converse.call_args.kwargs
        self.assertEqual(call['modelId'], 'test.small-model')
        self.assertEqual(call['inferenceConfig'], {'maxTokens': 1200, 'temperature': 0.3})
        self.assertEqual(json.loads(call['messages'][0]['content'][0]['text']), {'title': game['spec']['title'], 'description': game['spec']['description']})
        encoded = json.dumps(call)
        for secret in (support.USER, support.ORG, support.SERVICE, 'Bearer current', game['messages'][0]['text']):
            self.assertNotIn(secret, encoded)
        self.assertNotIn('toolConfig', call)
        self.assertIn('untrusted topic data', call['system'][0]['text'])

    def test_exact_json_fence_is_inert_formatting_and_still_validates_complete_grid(self):
        content = json.dumps({'entries': self.entries})
        for wrapped in (content, f'```json\n{content}\n```', f'```\n{content}\n```', f' \n```json\r\n{content}\r\n```\t\n'):
            self.assertEqual(self.generated_content(wrapped), self.entries)
        # A fence never excuses an invalid or disconnected puzzle.
        disconnected = {'entries': [{'answer': answer, 'clue': 'A synthetic clue'} for answer in ('AAA', 'BBB', 'CCC')]}
        self.generated_error('```json\n' + json.dumps(disconnected) + '\n```', 'one connected crossword')

    def test_ascii_case_single_word_separators_and_ordinary_clue_padding_are_normalized(self):
        formatted = [{'answer': (' ' if index % 2 else '-').join(entry['answer'].lower()),
            'clue': '  ' + entry['clue'] + '  '} for index, entry in enumerate(self.entries)]
        before = deepcopy(formatted)
        self.assertEqual(self.generated_content(json.dumps({'entries': formatted})), self.entries)
        self.assertEqual(formatted, before)
        # Eighteen letters with single separators exercise the 35-character raw bound.
        answer = 'A ' * 17 + 'A'
        normalized = games.crossword_candidate_entries([
            {'answer': answer, 'clue': 'A synthetic long answer'},
            {'answer': 'EARTH', 'clue': 'Our planet'}, {'answer': 'STAR', 'clue': 'A bright object in the night sky'}])
        self.assertEqual(normalized[0]['answer'], 'A' * 18)

    def test_duplicate_answers_after_normalization_are_rejected_before_layout(self):
        formatted = deepcopy(self.entries)
        formatted.append({'answer': ' '.join(self.entries[0]['answer'].lower()), 'clue': 'A second clue for the same answer'})
        with patch.object(games.word_games(), 'crossword', wraps=games.word_games().crossword) as layout:
            self.generated_error(json.dumps({'entries': formatted}), 'invalid or duplicate answers')
            # The helper validates its saved starter once; the duplicate pool
            # must not trigger a second layout search.
            layout.assert_called_once()

    def test_normalization_does_not_remove_arbitrary_punctuation_or_unsafe_answer_text(self):
        for answer in (' moon', 'moon ', 'moon--star', 'moon  star', 'moon- star', 'moon_star', 'moon/star',
                'https://example.test', 'fetch(secret)', 'm\u2014oon', 'm\u00a0oon', '\uff2d\uff2f\uff2f\uff2e', 'A' * 36, 'A' * 19, 'A'):
            entries = deepcopy(self.entries); entries[0]['answer'] = answer
            self.generated_error(json.dumps({'entries': entries}), 'invalid or duplicate answers')

    def test_clue_padding_only_trims_ordinary_spaces_and_never_links_or_code(self):
        for clue in ('\tA clue', 'A clue\n', '\u00a0A clue', 'A clue\u00a0', '<script>DO_NOT_LOG_THIS</script>',
                'https://DO_NOT_LOG_THIS.example', 'fetch(DO_NOT_LOG_THIS)', ' ' * 4, 'A' * 141):
            entries = deepcopy(self.entries); entries[0]['clue'] = clue
            self.generated_error(json.dumps({'entries': entries}), 'invalid clue text')

    def test_no_prose_code_fence_language_or_json_extraction_is_accepted(self):
        content = json.dumps({'entries': self.entries})
        for wrapped in ('DO_NOT_LOG_THIS ' + content, content + ' DO_NOT_LOG_THIS',
                f'DO_NOT_LOG_THIS\n```json\n{content}\n```', f'```json\n{content}\n```\nDO_NOT_LOG_THIS',
                f'```javascript\n{content}\n```', f'````json\n{content}\n````',
                f'```json\n{content}\n```\n```json\n{content}\n```', f'/* DO_NOT_LOG_THIS */{content}'):
            self.generated_error(wrapped, 'invalid JSON')
        self.generated_error(json.dumps({'entries': self.entries, 'code': 'DO_NOT_LOG_THIS'}), 'unsupported suggestion schema')

    def test_fixed_failure_categories_distinguish_json_schema_answer_clue_and_grid_without_content(self):
        cases = [
            ('DO_NOT_LOG_THIS', 'invalid JSON'),
            ('{"entries":[],"entries":[]}', 'invalid JSON'),
            (json.dumps({'entries': self.entries, 'DO_NOT_LOG_THIS': True}), 'unsupported suggestion schema'),
            (json.dumps({'entries': [{'answer': 'DO_NOT_LOG_THIS', 'clue': 'A clue'}, *self.entries[1:]]}), 'invalid or duplicate answers'),
            (json.dumps({'entries': [{'answer': self.entries[0]['answer'], 'clue': 'https://DO_NOT_LOG_THIS.example'}, *self.entries[1:]]}), 'invalid clue text'),
            (json.dumps({'entries': [{'answer': answer, 'clue': 'DO_NOT_LOG_THIS'} for answer in ('AAA', 'BBB', 'CCC')]}), 'one connected crossword'),
        ]
        messages = {self.generated_error(content, category) for content, category in cases}
        self.assertEqual(len(messages), 5)

    def test_connected_pool_is_kept_complete_and_in_its_original_order(self):
        target = games.word_games().default_spec('crossword')
        before = deepcopy(target)
        fitted = games.fit_crossword_entries(target, self.entries)
        self.assertEqual(fitted, self.entries)
        self.assertEqual(target, before)

    def test_valid_vocabulary_with_disconnected_word_returns_only_model_derived_connected_options(self):
        target = games.word_games().default_spec('crossword')
        target.update(title='Synthetic saved crossword', description='A synthetic saved topic.', instructions='Keep these saved instructions.')
        target['puzzle']['seed'] = 4242
        before = deepcopy(target)
        pool = [*deepcopy(self.entries[:2]), {'answer': 'ZZZZ', 'clue': 'A disconnected synthetic word'}, *deepcopy(self.entries[2:])]
        self.provider.converse.return_value = self.response(pool)
        result = games.crossword_model_entries(self.af, {'instructions': ''}, {'target': 'test.small-model', 'maxOutputTokens': 1200}, target)
        self.assertEqual(result, self.entries)
        self.assertEqual(target, before)
        candidate = deepcopy(target); candidate['puzzle']['entries'] = result
        self.assertEqual(games.validate_spec(candidate), candidate)
        self.provider.converse.assert_called_once()

    def test_pool_is_validated_before_any_fitting_or_filtering(self):
        target = games.word_games().default_spec('crossword')
        bad_tails = [
            {'answer': 'ZZZZ', 'clue': 'https://DO_NOT_LOG_THIS.example'},
            {'answer': 'ZZZZ', 'clue': 'A clue', 'code': 'DO_NOT_LOG_THIS'},
            {'answer': self.entries[0]['answer'], 'clue': 'A duplicate answer'},
        ]
        with patch.object(games.word_games(), 'crossword', side_effect=AssertionError('Invalid pools cannot reach fitting.')):
            for tail in bad_tails:
                with self.assertRaises(games.GameError) as caught: games.fit_crossword_entries(target, [*self.entries, tail])
                self.assertEqual(caught.exception.status, 502)
                self.assertNotIn('DO_NOT_LOG_THIS', caught.exception.message)

    def test_no_connected_triple_fails_without_wasting_triple_layout_searches(self):
        target = games.word_games().default_spec('crossword')
        pool = [{'answer': answer, 'clue': 'A synthetic clue'} for answer in ('AA', 'AB', 'CC', 'CD', 'EE', 'EF')]
        with patch.object(games.word_games(), 'crossword', wraps=games.word_games().crossword) as layout:
            with self.assertRaises(games.GameError) as caught: games.fit_crossword_entries(target, pool)
            self.assertIn('one connected crossword', caught.exception.message)
            self.assertEqual(layout.call_count, 1)

    def test_subset_search_has_a_finite_total_work_budget_even_when_only_last_triple_fits(self):
        target = games.word_games().default_spec('crossword')
        pool = [{'answer': 'A' + chr(letter) + 'A', 'clue': 'A synthetic clue'} for letter in range(ord('B'), ord('R'))]
        calls, triples = [], []
        def bounded_layout(candidate, *, work_limit=None):
            answers = [entry['answer'] for entry in candidate['puzzle']['entries']]
            calls.append(work_limit)
            self.assertIs(type(work_limit), int)
            if len(answers) == 3:
                triples.append(answers)
                if len(triples) == 48: return None
            raise games.word_games().WordGameError('Synthetic bounded layout failure.')
        with patch.object(games.word_games(), 'crossword', side_effect=bounded_layout):
            result = games.fit_crossword_entries(target, pool)
        self.assertEqual(len(triples), 48)
        self.assertEqual([entry['answer'] for entry in result], triples[-1])
        self.assertLessEqual(len(calls), 1 + 48 + 2 * 13)
        self.assertLessEqual(sum(calls), 1104000)
        self.assertEqual(calls[0], 200000)
        self.assertEqual(calls.count(8000), 48)
        self.assertLessEqual(calls.count(20000), 26)

    def test_subset_search_never_tries_more_than_48_layout_triples(self):
        target = games.word_games().default_spec('crossword')
        pool = [{'answer': 'A' + chr(letter) + 'A', 'clue': 'A synthetic clue'} for letter in range(ord('B'), ord('R'))]
        with patch.object(games.word_games(), 'crossword', side_effect=games.word_games().WordGameError('Synthetic bounded failure.')) as layout:
            with self.assertRaises(games.GameError): games.fit_crossword_entries(target, pool)
            self.assertEqual(layout.call_count, 49)
            self.assertEqual(sum(call.kwargs['work_limit'] for call in layout.call_args_list), 200000 + 48 * 8000)

    def test_second_greedy_pass_can_include_an_earlier_word_after_a_later_bridge(self):
        words = games.word_games(); target = words.default_spec('crossword')
        pool = [{'answer': answer, 'clue': 'A synthetic clue'} for answer in ('CAT', 'CAR', 'ART', 'DOG', 'ROAD')]
        original_layout = words.crossword
        calls = []
        def limited_layout(candidate, *, work_limit=None):
            calls.append([entry['answer'] for entry in candidate['puzzle']['entries']])
            if len(calls) == 1: raise words.WordGameError('Synthetic initial pool work limit.')
            return original_layout(candidate, work_limit=work_limit)
        with patch.object(words, 'crossword', side_effect=limited_layout):
            fitted = games.fit_crossword_entries(target, pool)
        self.assertEqual(fitted, pool)
        # DOG has no letter in the first triple; ROAD adds its shared letters.
        # The final list still follows model order, after the deferred addition.
        self.assertIn(['CAT', 'CAR', 'ART', 'ROAD'], calls)
        self.assertEqual(calls[-1], ['CAT', 'CAR', 'ART', 'DOG', 'ROAD'])

    def test_crossword_internal_budget_is_bounded_and_default_layout_is_unchanged(self):
        words = games.word_games(); target = words.default_spec('crossword')
        baseline = words.crossword(target)
        self.assertEqual(words.crossword(target, work_limit=words.CROSSWORD_WORK_LIMIT), baseline)
        for invalid in (0, -1, True, 1.5, '1000', words.CROSSWORD_WORK_LIMIT + 1):
            with self.assertRaises(words.WordGameError) as caught: words.crossword(target, work_limit=invalid)
            self.assertIn('work limit is invalid', str(caught.exception))
        with self.assertRaises(words.WordGameError) as caught: words.crossword(target, work_limit=1)
        self.assertIn('search reached its work limit', str(caught.exception))
        # Resolve the global default when called, so existing bounded-engine
        # tests can still lower it without altering the function signature.
        with patch.object(words, 'CROSSWORD_WORK_LIMIT', 1):
            with self.assertRaises(words.WordGameError) as caught: words.crossword(target)
            self.assertIn('search reached its work limit', str(caught.exception))

    def test_incomplete_nonjson_code_and_disconnected_responses_never_change_game(self):
        self.configure(); original = self.crossword()
        invalid_outputs = [
            {'stopReason': 'max_tokens', 'output': {'message': {'content': [{'text': '{}'}]}}},
            {'stopReason': 'tool_use', 'output': {'message': {'content': [{'toolUse': {'name': 'fetch'}}]}}},
            {'stopReason': 'end_turn', 'output': {'message': {'content': [{'text': '```json\n{}\n```'}]}}},
            {'stopReason': 'end_turn', 'output': {'message': {'content': [{'text': '{"entries":[],"entries":[]}'}]}}},
            self.response([{'answer': word, 'clue': 'A clue'} for word in ('AAA', 'BBB', 'CCC')]),
            self.response([{'answer': 'CODE', 'clue': 'https://example.test'}] * 3),
            self.response([{'answer': 'word', 'clue': 'A clue'}] * 3),
            self.response(self.entries + [self.entries[0]]),
            self.response([{'answer': 'MOON', 'clue': 'A clue', 'code': 'alert(1)'}] * 3),
            self.response(self.entries[:2]),
            self.response(self.entries * 4),
        ]
        for index, response in enumerate(invalid_outputs):
            # Independent draft avoids confusing the intended never-replay behavior.
            game_id = f'{index + 20:08x}-1111-4111-8111-111111111111'
            game = self.create(game_id, 'A crossword about nature')
            self.provider.converse.return_value = response
            self.error(502, lambda: self.suggest(game))
            pending = games.load(self.api, self.claims, game_id)[0]
            self.assertEqual(pending['spec'], original['spec'])
            self.assertNotIn('_crosswordSuggestions', pending)
            self.error(409, lambda: self.suggest(game))
        self.assertEqual(self.provider.converse.call_count, len(invalid_outputs))

    def test_per_draft_call_turn_input_and_storage_limits_precede_provider(self):
        registry = self.configure(); game = self.crossword()
        for field, value in (('_modelCalls', registry['limits']['maxModelCalls']), ('_turns', registry['limits']['maxTurns'])):
            state = json.loads(self.stored()['payload']); state[field] = value
            self.database.rows['games'][games.key('game', game['id'])] = games.envelope('game', state, support.USER)
            self.error(403, lambda: self.suggest(game))
            state[field] = 0
            self.database.rows['games'][games.key('game', game['id'])] = games.envelope('game', state, support.USER)
        registry['limits']['maxInputChars'] = 100; self.write_registry(registry)
        candidate = deepcopy(game['spec']); candidate['description'] = 'A' * 101
        game = games.update(self.api, self.claims, game['id'], {'revision': game['revision'], 'spec': candidate})
        self.error(403, lambda: self.suggest(game))
        registry['limits']['maxInputChars'] = 6000; self.write_registry(registry)
        state = json.loads(self.stored()['payload']); state['messages'] = [{'text': 'A' * 288000}]
        self.database.rows['games'][games.key('game', game['id'])] = games.envelope('game', state, support.USER)
        self.error(413, lambda: self.suggest(game))
        self.provider.converse.assert_not_called()

    def test_multi_game_targets_only_saved_crossword_child_and_keeps_other_steps(self):
        self.configure(); game = self.create(prompt='Create a multi-game journey')
        before = deepcopy(game['spec'])
        result = self.suggest(game, path=['step-1'])
        self.assertEqual(result['game']['spec'], before)
        self.assertEqual(result['proposal']['path'], ['step-1'])
        for path in ([], ['step-2'], ['step-3']):
            body = {**self.body(result['game'], support.SECOND, ['step-1']), 'path': path}
            self.error(409, lambda: self.suggest(result['game'], body=body))
        self.provider.converse.assert_called_once()

    def test_creation_or_registry_revoke_race_prevents_reservation_and_billing(self):
        registry = self.configure(); game = self.crossword()
        def revoke():
            registry['revision'] += 1; registry['allowPaidExecution'] = False; self.write_registry(registry)
        self.race_once(revoke)
        self.error(409, lambda: self.suggest(game))
        self.assertEqual(games.load(self.api, self.claims, game['id'])[0]['revision'], game['revision'])
        self.provider.converse.assert_not_called()

    def test_registry_permission_and_creation_revocation_during_provider_discard_suggestions(self):
        for kind in ('registry', 'permission', 'creation'):
            self.claims['permissions'] = ['games-create', 'games-manage', 'agents-manage']; registry = self.configure()
            game_id = {'registry': support.GAME, 'permission': support.COPY, 'creation': support.SECOND}[kind]
            game = self.create(game_id, 'A crossword about nature')
            def respond(**kwargs):
                if kind == 'registry':
                    registry['revision'] += 1; registry['allowPaidExecution'] = False; self.write_registry(registry)
                elif kind == 'permission': self.claims['permissions'] = []
                else: self.save_config(lambda value: value.update(creationEnabled=False))
                return self.response()
            self.provider.converse.side_effect = respond
            self.error(409 if kind == 'creation' else 403, lambda: self.suggest(game))
            state = json.loads(self.stored(game_id)['payload'])
            self.assertEqual(state['spec'], game['spec']); self.assertIn('_pending', state)
            self.assertNotIn('_crosswordSuggestions', state)
        self.assertEqual(self.provider.converse.call_count, 3)

    def test_manual_edit_during_provider_wins_without_overwriting_saved_words(self):
        self.configure(); game = self.crossword()
        def respond(**kwargs):
            pending = games.load(self.api, self.claims, game['id'])[0]
            spec = deepcopy(pending['spec']); spec['title'] = 'Human wins'
            games.update(self.api, self.claims, game['id'], {'revision': pending['revision'], 'spec': spec})
            return self.response()
        self.provider.converse.side_effect = respond
        self.error(409, lambda: self.suggest(game))
        current = games.load(self.api, self.claims, game['id'])[0]
        self.assertEqual(current['spec']['title'], 'Human wins')
        self.assertNotIn('_crosswordSuggestions', current)

    def test_proposals_and_receipts_do_not_leak_into_publication_or_duplicates(self):
        self.configure(); game = self.publish(self.finish_test(self.crossword()))
        snapshot = deepcopy(self.database.rows['published-games'])
        result = self.suggest(game)
        self.assertEqual(self.database.rows['published-games'], snapshot)
        duplicated = games.duplicate(self.api, self.claims, game['id'], {'revision': result['game']['revision'], 'id': support.COPY})
        copied = json.loads(self.stored(support.COPY)['payload'])
        self.assertNotIn('_crosswordSuggestions', copied)
        self.assertEqual(copied['_requests'], []); self.assertEqual(copied['_modelCalls'], 0)
        published = self.publish(self.finish_test(result['game']))
        self.assertNotIn('_crosswordSuggestions', published)
        self.assertNotIn('proposal', published)
        public = json.loads(self.database.rows['published-games'][games.key('game', game['id'])]['payload'])
        self.assertNotIn('_crosswordSuggestions', public)
        self.assertNotIn('_requests', public)
        self.assertEqual(duplicated['status'], 'Draft')


if __name__ == '__main__': unittest.main()
