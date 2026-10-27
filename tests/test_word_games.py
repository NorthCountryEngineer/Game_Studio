"""Offline word-game validation, deterministic layouts, and protected lifecycle.

Every record is synthetic, every provider is mocked, and sockets are blocked.
"""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import socket
import unittest
from unittest.mock import patch

import test_games as support

games = support.games
words = games.word_games()
source = importlib.util.spec_from_file_location('word_game_scores_test', Path(__file__).parents[1] / 'backend/nce_api/game_scores.py')
scores = importlib.util.module_from_spec(source); source.loader.exec_module(scores)


class WordSpecTests(unittest.TestCase):
    def setUp(self):
        for name in ('socket', 'create_connection'):
            blocked = patch.object(socket, name, side_effect=AssertionError('Network is disabled in offline tests.'))
            blocked.start(); self.addCleanup(blocked.stop)

    def rejected(self, value):
        with self.assertRaises(games.GameError) as error: games.validate_spec(value)
        self.assertEqual(error.exception.status, 400)

    def test_curated_starters_validate_without_io_and_return_independent_values(self):
        for genre in ('crossword', 'word-search', 'mad-libs'):
            for topic in words.PACKS:
                spec = words.default_spec(genre, topic)
                self.assertEqual(games.validate_spec(spec), spec)
                self.assertEqual(games.get_levels(spec), [{'id': 'level-1', 'title': spec['title'], 'brief': spec['instructions']}])
        before = words.default_spec(); before['puzzle']['entries'][0]['clue'] = 'Edited'
        self.assertNotEqual(words.default_spec()['puzzle']['entries'][0]['clue'], 'Edited')

    def test_common_schema_rejects_unknown_missing_fields_and_unsafe_text(self):
        original = words.default_spec('word-search')
        for extra in ('arcade', 'levels', 'code', 'url', 'theme', 'tenant'):
            spec = deepcopy(original); spec[extra] = 'unsupported'; self.rejected(spec)
        for missing in original:
            spec = deepcopy(original); spec.pop(missing); self.rejected(spec)
        for title in ('', ' leading', 'trailing ', 'x' * 81, '🦎' * 41, '<b>title', 'https://example.test', 'ftp://example.test', 's3://private-bucket', 'mailto:person@example.test', 'file:/etc/hosts', 'tel:5555555555', 'data\ufeff:abc', 'fetch\u00a0(', '\ud800', 'a\nb', 'a\x7fb'):
            spec = deepcopy(original); spec['title'] = title; self.rejected(spec)
        self.assertEqual(games.validate_spec({**original, 'title': '🦎' * 40})['title'], '🦎' * 40)
        spec = deepcopy(original); spec['genre'] = 'collect'; self.rejected(spec)

    def test_numeric_fields_match_js_whole_numbers_and_reject_booleans(self):
        original = words.default_spec('word-search')
        for field, invalid in [('seed', [True, False, 0, 2147483648, 10 ** 1000, 1.1, '1', None, float('nan'), float('inf')]), ('size', [True, 9, 25, 12.5, '12', None])]:
            for value in invalid:
                spec = deepcopy(original); spec['puzzle'][field] = value; self.rejected(spec)
        spec = deepcopy(original); spec.update(version=3.0); spec['puzzle'].update(seed=17031.0, size=12.0)
        self.assertEqual(games.validate_spec(spec), original)
        for value in (1, 'true', None):
            spec = deepcopy(original); spec['puzzle']['allowBackwards'] = value; self.rejected(spec)

    def test_crossword_requires_complete_unique_bounded_interlocking_vocabulary(self):
        original = words.default_spec()
        for entries in ([], original['puzzle']['entries'][:2], [{'answer': 'AA', 'clue': 'A'}] * 17,
                [{'answer': 'AA', 'clue': 'A'}, {'answer': 'BB', 'clue': 'B'}, {'answer': 'CC', 'clue': 'C'}],
                [{'answer': 'AAA', 'clue': 'A'}, {'answer': 'AAA', 'clue': 'Another A'}, {'answer': 'AB', 'clue': 'B'}]):
            spec = deepcopy(original); spec['puzzle']['entries'] = entries; self.rejected(spec)
        for answer in ('aA', 'ÉTÉ', 'A A', 'A', 'A' * 19, 2):
            spec = deepcopy(original); spec['puzzle']['entries'][0]['answer'] = answer; self.rejected(spec)
        for clue in ('', 'x' * 141, 'Read www.example.test', 'a\nb'):
            spec = deepcopy(original); spec['puzzle']['entries'][0]['clue'] = clue; self.rejected(spec)
        spec = deepcopy(original); spec['puzzle']['entries'][0]['asset'] = 'unsupported'; self.rejected(spec)
        spec = deepcopy(original); spec['puzzle']['entries'] = [{'answer': chr(65 + i) + 'A' * 17, 'clue': 'A clue'} for i in range(12)]; self.rejected(spec)

    def test_crossword_layout_contains_every_letter_and_crossing_without_parallel_overlap(self):
        spec = words.default_spec('crossword', 'animals')
        layout = words.crossword(spec)
        self.assertEqual(layout, words.crossword(spec)); self.assertEqual(layout['size'], 25)
        self.assertEqual([e['answer'] for e in layout['entries']], [e['answer'] for e in spec['puzzle']['entries']])
        cells, occupied = {}, {}
        for entry in layout['entries']:
            dr, dc = (1, 0) if entry['direction'] == 'down' else (0, 1)
            own = set()
            for k, letter in enumerate(entry['answer']):
                cell = (entry['row'] + dr * k, entry['col'] + dc * k)
                self.assertEqual(layout['grid'][cell[0]][cell[1]], letter)
                self.assertNotIn(entry['direction'], occupied.get(cell, []))
                occupied.setdefault(cell, []).append(entry['direction']); own.add(cell)
            cells[entry['answer']] = own
            before = (entry['row'] - dr, entry['col'] - dc)
            after = (entry['row'] + dr * len(entry['answer']), entry['col'] + dc * len(entry['answer']))
            for row, col in (before, after):
                if 0 <= row < 25 and 0 <= col < 25: self.assertEqual(layout['grid'][row][col], '')
        reached = {layout['entries'][0]['answer']}
        while True:
            more = {answer for answer, own in cells.items() if any(own & cells[prior] for prior in reached)}
            if more <= reached: break
            reached |= more
        self.assertEqual(reached, set(cells))
        for (row, col), directions in occupied.items():
            if len(directions) == 1:
                dr, dc = (0, 1) if directions[0] == 'down' else (1, 0)
                for r, c in ((row - dr, col - dc), (row + dr, col + dc)):
                    if 0 <= r < 25 and 0 <= c < 25: self.assertFalse(layout['grid'][r][c])
        starts = sorted({(e['row'], e['col']) for e in layout['entries']})
        for entry in layout['entries']: self.assertEqual(entry['number'], starts.index((entry['row'], entry['col'])) + 1)

    def test_word_search_keeps_complete_vocabulary_and_repeatable_filler(self):
        for backwards in (False, True):
            spec = words.default_spec('word-search'); spec['puzzle']['allowBackwards'] = backwards
            layout = words.word_search(spec)
            self.assertEqual(layout, words.word_search(spec))
            self.assertEqual({p['word'] for p in layout['placements']}, set(spec['puzzle']['words']))
            self.assertTrue(all(len(row) == 12 and all('A' <= c <= 'Z' for c in row) for row in layout['grid']))
            for p in layout['placements']:
                actual = ''.join(layout['grid'][p['row'] + p['dr'] * k][p['col'] + p['dc'] * k] for k in range(len(p['word'])))
                self.assertEqual(actual, p['word'])
                if not backwards: self.assertGreaterEqual(p['dc'], 0)
        spec = words.default_spec('word-search'); spec['puzzle'].update(size=10, seed=1, words=[chr(65 + i) * 10 for i in range(10)])
        layout = words.word_search(games.validate_spec(spec))
        self.assertEqual([p['row'] for p in layout['placements']], list(range(10)))
        self.assertTrue(all(p['dr'] == 0 and p['dc'] == 1 for p in layout['placements']))

    def test_pathological_crossword_stops_at_fixed_work_bound_without_dropping_words(self):
        spec = words.default_spec()
        vocabulary = ['APPLE', 'PEAR', 'GRAPE', 'ORANGE', 'MELON', 'PLUM', 'PEACH', 'LEMON', 'LIME', 'MANGO', 'PAPAYA', 'CHERRY', 'BANANA', 'APRICOT', 'COCONUT', 'ZZ']
        spec['puzzle'].update(seed=1, entries=[{'answer': value, 'clue': 'Test'} for value in vocabulary])
        self.assertEqual(words.CROSSWORD_WORK_LIMIT, 2000000)
        with self.assertRaises(games.GameError) as error: games.validate_spec(spec)
        self.assertEqual(error.exception.message, 'Crossword layout search reached its work limit. Edit the vocabulary or seed; every word must fit.')
        self.assertEqual(len(spec['puzzle']['entries']), 16)
        spec['puzzle']['entries'][-1]['answer'] = 'DATE'
        self.assertEqual(len(words.crossword(games.validate_spec(spec))['entries']), 16)

    def test_word_search_rejects_duplicates_excess_count_and_words_that_cannot_fit(self):
        original = words.default_spec('word-search')
        for value in (['AB', 'CD'], ['AB', 'AB', 'CD'], ['A' * 13, 'AB', 'CD'], [chr(65 + i) + 'A' for i in range(13)]):
            spec = deepcopy(original); spec['puzzle']['words'] = value; self.rejected(spec)

    def test_mad_libs_tokens_are_declared_bounded_used_and_render_as_plain_text(self):
        original = words.default_spec('mad-libs')
        self.assertEqual(words.story(original, {'blank-1': 'tiny', 'blank-2': 'hat', 'blank-3': 'dance'}),
            'One day, a tiny explorer took a hat to the park. There they decided to dance beside a tiny tree.')
        for template in ('No blanks here.', '{{blank-0}}', '{{blank-13}}', '{{blank-1}} {{blank-2}} {{blank-3}} {{secret}}', '{blank-1}', '{{blank-1}} {{blank-2}} {{blank-3}} {', 'x' * 2001):
            spec = deepcopy(original); spec['puzzle']['template'] = template; self.rejected(spec)
        for blank in ({'id': 'blank-13', 'label': 'Noun'}, {'id': 'blank-1', 'label': '<script>'}, {'id': 'blank-1', 'label': 'x' * 61}, {'id': 'blank-1', 'label': 'Noun', 'answer': 'private'}):
            spec = deepcopy(original); spec['puzzle']['blanks'][0] = blank; self.rejected(spec)
        spec = deepcopy(original); spec['puzzle']['blanks'][1]['id'] = 'blank-1'; self.rejected(spec)
        for answers in ({}, {'blank-1': '<script>', 'blank-2': 'hat', 'blank-3': 'dance'}, {'blank-1': 'x' * 81, 'blank-2': 'hat', 'blank-3': 'dance'}):
            with self.assertRaises(words.WordGameError): words.story(original, answers)

    def test_guided_designer_preserves_authored_content_and_discloses_starter_limits(self):
        before = games.design_game('A crossword about space')['spec']
        edited = games.design_game('Title: Our authored title', before)
        self.assertEqual(edited['spec']['puzzle'], before['puzzle'])
        self.assertEqual(edited['spec']['title'], 'Our authored title')
        self.assertIn('calls no AI model', edited['reply'])
        arbitrary = games.design_game('A crossword about medieval architecture')
        self.assertIn('arbitrary-topic content is not generated', arbitrary['reply'])
        self.assertEqual(arbitrary['spec']['puzzle'], words.default_spec()['puzzle'])
        searched = games.design_game('word search\nWords: WATER, RIVER, RAIN\nSize: 10\nBackwards: on')['spec']
        self.assertEqual(searched['puzzle'], {'seed': 17031, 'size': 10, 'allowBackwards': True, 'words': ['WATER', 'RIVER', 'RAIN']})
        story = games.design_game('mad libs\nTemplate: A {{blank-1}} day.\nBlanks: blank-1 | adjective')['spec']
        self.assertEqual(story['puzzle']['blanks'], [{'id': 'blank-1', 'label': 'adjective'}])

    def test_authored_fields_do_not_request_a_new_genre_or_topic(self):
        before = words.default_spec('word-search', 'space')
        for message in ('Title: Crossword hunt', 'Description: A crossword about garden plants'):
            after = games.design_game(message, before)['spec']
            self.assertEqual(after['genre'], before['genre']); self.assertEqual(after['puzzle'], before['puzzle'])
        before['puzzle'].update(size=18, allowBackwards=True)
        for message in ('Title: Size 10 treasure hunt', 'Description: Backwards off in the title', 'Instructions: Find words on a grid 10 with no backwards surprises'):
            self.assertEqual(games.design_game(message, before)['spec']['puzzle'], before['puzzle'])
        story = words.default_spec('mad-libs', 'space')
        template = 'A {{blank-1}} crossword about garden plants had a {{blank-2}} that could {{blank-3}}.'
        after = games.design_game('Template: ' + template, story)['spec']
        self.assertEqual(after['genre'], 'mad-libs'); self.assertEqual(after['puzzle']['template'], template)
        crossword = words.default_spec('crossword', 'space')
        after = games.design_game('Entries:\nWATER | A crossword about garden plants\nRIVER | A stream\nRAIN | Drops from clouds', crossword)['spec']
        self.assertEqual(after['title'], crossword['title'])
        self.assertEqual([e['answer'] for e in after['puzzle']['entries']], ['WATER', 'RIVER', 'RAIN'])


class WordLifecycleTests(unittest.TestCase):
    authorize = support.GameTests.authorize
    event = support.GameTests.event
    error = support.GameTests.error
    create = support.GameTests.create
    message = support.GameTests.message
    publish = support.GameTests.publish
    finish_test = support.GameTests.finish_test
    stored = support.GameTests.stored
    configure_model = support.GameTests.configure_model
    write_registry = support.GameTests.write_registry
    save_config = support.GameTests.save_config

    def setUp(self):
        support.GameTests.setUp(self)
        for name in ('socket', 'create_connection'):
            blocked = patch.object(socket, name, side_effect=AssertionError('Network is disabled in offline tests.'))
            blocked.start(); self.addCleanup(blocked.stop)

    def test_word_publication_requires_explicit_review_of_the_saved_revision(self):
        state = self.create(prompt='A crossword about science')
        self.assertEqual(state['spec']['version'], 3)
        self.assertEqual(state['status'], 'Draft'); self.assertFalse(self.database.rows['published-games'])
        self.error(409, lambda: self.publish(state))
        for ids in (None, [], ['level-2'], ['level-1', 'level-1']):
            body = {'revision': state['revision']}
            if ids is not None: body['reviewedLevelIds'] = ids
            self.error(400, lambda: games.complete_test(self.api, self.claims, state['id'], body))
        tested = self.finish_test(state); published = self.publish(tested)
        self.assertEqual(published['status'], 'Published')
        snapshot = games.dispatch(self.api, {}, 'GET', '/games/published/' + state['id'], {})
        self.assertEqual(snapshot['spec'], state['spec']); self.assertNotIn('messages', snapshot)
        edited = self.message(published, 'Title: Updated draft')
        self.assertNotIn('testedRevision', edited); self.error(409, lambda: self.publish(edited))
        self.assertEqual(games.dispatch(self.api, {}, 'GET', '/games/published/' + state['id'], {})['spec'], snapshot['spec'])
        self.provider.converse.assert_not_called()

    def test_public_catalog_negotiation_preserves_legacy_and_private_contracts(self):
        word = self.publish(self.finish_test(self.create(prompt='A word search')))
        action = self.publish(self.finish_test(self.create(support.COPY)))
        legacy = games.list_games(self.api, None, {}, True)
        modern = games.list_games(self.api, None, {'queryStringParameters': {'specVersion': 'all'}}, True)
        self.assertEqual([g['id'] for g in legacy['games']], [action['id']])
        self.assertEqual({g['id'] for g in modern['games']}, {word['id'], action['id']})
        self.assertEqual(len(games.list_games(self.api, self.claims, {})['games']), 2)
        for query in ({'specVersion': '3'}, {'specVersion': ''}, {'genre': 'crossword'}, {'specVersion': ['all']}):
            self.error(400, lambda: games.list_games(self.api, None, {'queryStringParameters': query}, True))

    def test_filtered_public_catalog_keeps_cursor_for_empty_scan_pages(self):
        state = self.publish(self.finish_test(self.create(prompt='mad libs')))
        cursor = {'id': games.key('game', state['id'])}
        item = self.database.rows['published-games'][cursor['id']]
        original = self.database.Table
        class Page:
            def scan(self, **_): return {'Items': [item], 'LastEvaluatedKey': cursor}
        with patch.object(self.database, 'Table', side_effect=lambda name: Page() if name == 'published-games' else original(name)):
            result = games.list_games(self.api, None, {}, True)
        self.assertEqual(result['games'], []); self.assertTrue(result['cursor'])

    def test_word_drafts_keep_owner_tenant_revision_and_duplication_boundaries(self):
        state = self.create(prompt='mad libs')
        self.claims.update(sub=support.OTHER, permissions=['games-create'])
        self.error(404, lambda: games.load(self.api, self.claims, state['id']))
        self.claims.update(sub=support.USER, permissions=['games-create', 'games-publish'])
        changed = self.message(state, 'Title: My saved story')
        self.error(409, lambda: games.update(self.api, self.claims, state['id'], {'revision': state['revision'], 'spec': state['spec']}))
        copied = games.duplicate(self.api, self.claims, state['id'], {'revision': changed['revision'], 'id': support.COPY})
        self.assertEqual(copied['spec']['puzzle'], changed['spec']['puzzle']); self.assertEqual(copied['status'], 'Draft'); self.assertNotIn('testedRevision', copied)
        row = self.stored(); row['organization_id'] = support.OTHER
        self.error(404, lambda: games.load(self.api, self.claims, state['id']))
        self.provider.converse.assert_not_called()

    def test_word_games_cannot_read_or_write_shared_arcade_boards(self):
        state = self.publish(self.finish_test(self.create(prompt='word search')))
        for fn in (lambda: scores.get_scores(self.api, state['id'], state['publishedRevision']),
                lambda: scores.submit_score(self.api, self.claims, state['id'], {'publishedRevision': state['publishedRevision'], 'requestId': support.REQUEST, 'name': 'PLAYER', 'result': {}})):
            with self.assertRaises(scores.ScoreError) as error: fn()
            self.assertEqual(error.exception.status, 404)
        self.assertFalse(any(key.startswith('game-score:') for key in self.database.rows['published-games']))
        with self.assertRaises(scores.ScoreError): scores.validate_result({}, state['spec'])

    def test_duplicate_word_titles_remain_valid_at_utf16_and_whitespace_boundaries(self):
        state = self.create(prompt='mad libs')
        for title, target in zip(('🦎' * 40, 'A' * 71 + ' ' + 'end'), (support.COPY, support.SECOND)):
            candidate = deepcopy(state['spec']); candidate['title'] = title
            state = games.update(self.api, self.claims, state['id'], {'revision': state['revision'], 'spec': candidate})
            copied = games.duplicate(self.api, self.claims, state['id'], {'revision': state['revision'], 'id': target})
            self.assertEqual(games.validate_spec(copied['spec']), copied['spec'])

    def test_word_model_prompt_is_bounded_data_only_and_wrong_schema_is_rejected(self):
        state = self.create(prompt='A crossword about nature')
        candidate = deepcopy(state['spec']); candidate['title'] = 'A proposed edit'
        self.provider.converse.return_value = {'stopReason': 'end_turn', 'output': {'message': {'content': [{'text': json.dumps({'text': 'Please review this edit.', 'spec': candidate})}]}}}
        selected = {'target': 'admin-selected-test-model', 'maxOutputTokens': 1024}
        generated, _ = games.model_spec(self.af, {'instructions': 'Use short clues.'}, selected, state, 'Change the title')
        self.assertEqual(generated, candidate)
        call = self.provider.converse.call_args.kwargs
        self.assertEqual(call['inferenceConfig']['maxTokens'], 1024)
        self.assertEqual(call['modelId'], 'admin-selected-test-model')
        self.assertNotIn('toolConfig', call)
        self.assertIn('version integer 3', call['system'][0]['text'])
        self.assertIn('human must finish, review', call['system'][0]['text'])
        for wrong in (games.default_spec(), {**candidate, 'code': 'alert(1)'}, {**candidate, 'genre': 'word-search'}):
            self.provider.converse.return_value['output']['message']['content'][0]['text'] = json.dumps({'text': 'Changed', 'spec': wrong})
            self.error(400 if wrong.get('version') == 3 else 502, lambda: games.model_spec(self.af, {'instructions': ''}, selected, state, 'Change the title'))
        self.provider.converse.return_value['stopReason'] = 'max_tokens'
        self.error(502, lambda: games.model_spec(self.af, {'instructions': ''}, selected, state, 'Change the title'))

    def test_configured_word_request_is_reserved_once_and_identical_retry_is_idempotent(self):
        state = self.create(prompt='word search'); self.configure_model()
        candidate = deepcopy(state['spec']); candidate['title'] = 'Mocked model title'
        self.provider.converse.return_value = {'stopReason': 'end_turn', 'output': {'message': {'content': [{'text': json.dumps({'text': 'Review the words.', 'spec': candidate})}]}}}
        result = self.message(state, 'Title: Mocked model title')
        self.assertEqual(result['spec'], candidate); self.assertNotIn('testedRevision', result)
        self.assertEqual(self.message(state, 'Title: Mocked model title'), result)
        self.provider.converse.assert_called_once()
        self.assertFalse(self.database.rows['published-games'])


if __name__ == '__main__': unittest.main()
