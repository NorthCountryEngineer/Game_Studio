"""Anonymous universal boards: bounded admission, exact editions and old data preservation."""
from copy import deepcopy
import hashlib
import base64
import json
import unittest
from unittest.mock import patch
import uuid

import test_game_scores as support

scores, games, fixtures = support.scores, support.games, support.support


class PublicScoreTests(unittest.TestCase):
    setUp = support.ScoreTests.setUp
    event = support.ScoreTests.event
    create = support.ScoreTests.create
    authorize = support.ScoreTests.authorize
    publish = support.ScoreTests.publish
    finish_test = support.ScoreTests.finish_test
    report = support.ScoreTests.report
    submit = support.ScoreTests.submit
    get = support.ScoreTests.get
    error = support.ScoreTests.error
    stored_board = support.ScoreTests.stored_board
    race_once = support.ScoreTests.race_once

    def publish_spec(self, spec):
        saved = games.update(self.api, self.claims, fixtures.GAME, {'revision': self.published['revision'], 'spec': spec})
        ids = [step['id'] for step in spec['steps']] if spec['version'] == 8 else [level['id'] for level in games.get_levels(spec)]
        if games.is_endless_asteroids(spec): ids = ids[:1]
        tested = games.complete_test(self.api, self.claims, fixtures.GAME, {'revision': saved['revision'], 'reviewedLevelIds': ids})
        self.published = self.publish(tested); self.revision = self.published['publishedRevision']
        return spec

    def result(self, spec=None, outcome='won', elapsed=10):
        spec = spec or self.published['spec']
        if spec['version'] == 3:
            field = 'entries' if spec['genre'] == 'crossword' else 'words' if spec['genre'] == 'word-search' else 'blanks'
            return {'outcome': outcome, 'elapsed': elapsed, 'score': len(spec['puzzle'][field]), 'reviewedLevelIds': ['level-1']}
        levels = games.get_levels(spec)
        if 'flow' in spec:
            by_id = {level['id']: level for level in levels}
            levels = [by_id[node['levelId']] for node in spec['flow']['nodes'] if node['type'] == 'level']
        if outcome == 'lost': levels = levels[:1]
        result = {'outcome': outcome, 'elapsed': elapsed, 'score': sum(level['rules']['goal'] for level in levels) if outcome == 'won' else 0, 'reviewedLevelIds': [level['id'] for level in levels]}
        if scores.ranking(spec) == 'points': result['points'] = result['score'] * 10
        return result

    def submit_result(self, result, name='Player', request=None, event=None):
        body = self.report(request=request or str(uuid.uuid4()), name=name, result=result)
        return scores.dispatch(self.api, {} if event is None else event, 'POST', '/game-scores/' + fixtures.GAME, body)

    def test_word_formats_rank_successful_completion_time_without_inventing_points(self):
        for genre in ['crossword', 'word-search', 'mad-libs']:
            spec = self.publish_spec(games.word_games().default_spec(genre))
            self.assertEqual(self.get()['ranking'], 'time')
            won = self.result(spec)
            first = self.submit_result(won)
            self.assertTrue(first['qualified']); self.assertNotIn('points', first['entries'][0])
            faster = self.submit_result({**won, 'elapsed': 4}, name='Player')
            self.assertEqual([entry['elapsed'] for entry in faster['entries']], [4, 10])
            for value in [{**won, 'elapsed': 0}, {**won, 'outcome': 'lost'}, {**won, 'score': 0}, {**won, 'points': 10}]:
                self.error(400, lambda: self.submit_result(value))
        self.authorization.assert_not_called(); self.provider.converse.assert_not_called()

    def test_plain_collection_and_disabled_asteroid_high_scores_still_have_a_board(self):
        spec = self.publish_spec(games.design_game('A collection game with two levels.')['spec'])
        self.assertEqual(self.get()['ranking'], 'time')
        self.assertTrue(self.submit_result(self.result(spec))['qualified'])
        spec = self.publish_spec(games.design_game('Asteroids. High scores off.')['spec'])
        self.assertFalse(spec['arcade']['highScores']); self.assertEqual(self.get()['ranking'], 'points')
        self.assertTrue(self.submit_result(self.result(spec))['qualified'])

    def test_zero_point_terminal_round_can_rank_but_zero_time_cannot(self):
        self.assertTrue(self.submit(self.report(points=0))['qualified'])
        value = self.report(points=0, request=fixtures.SECOND); value['result']['elapsed'] = 0
        self.error(400, lambda: self.submit(value))

    def test_platformer_points_are_exact_rewards_and_strictly_bounded(self):
        spec = self.publish_spec(games.create_platformer_spec())
        won = self.result(spec)
        self.assertEqual(self.get()['ranking'], 'points')
        self.assertEqual(self.submit_result(won)['entries'][0]['points'], won['score'] * 10)
        self.error(400, lambda: self.submit_result({**won, 'points': won['points'] - 1}))
        self.error(400, lambda: self.submit_result({**won, 'score': won['score'] - 1}))
        self.error(400, lambda: self.submit_result({key: value for key, value in won.items() if key != 'points'}))

    def test_pointless_endless_game_ranks_longest_survival_and_never_a_fake_win(self):
        spec = games.design_game('Asteroids with endless survival.')['spec']
        spec['arcade'].update(scoring=False, highScores=False)
        spec = self.publish_spec(spec)
        self.assertEqual(self.get()['ranking'], 'survival')
        lost = self.result(spec, 'lost', 30)
        self.assertNotIn('points', lost)
        self.submit_result(lost)
        board = self.submit_result({**lost, 'elapsed': 60})
        self.assertEqual([entry['elapsed'] for entry in board['entries']], [60, 30])
        for value in [{**lost, 'outcome': 'won'}, {**lost, 'elapsed': 0}, {**lost, 'points': 0}]:
            self.error(400, lambda: self.submit_result(value))

    def test_full_board_requires_strict_improvement_and_nonqualifier_is_idempotent(self):
        for index in range(10): self.submit(self.report(100 + index, str(uuid.uuid4()), name='same'))
        body = self.report(100, fixtures.SECOND, 'tie')
        first = self.submit(body); self.assertFalse(first['qualified'])
        self.assertEqual(len(first['entries']), 10)
        count = self.database.meta.client.transact_write_items.call_count
        self.assertEqual(self.submit(body), first)
        self.assertEqual(self.database.meta.client.transact_write_items.call_count, count)
        self.error(409, lambda: self.submit({**body, 'name': 'changed'}))
        self.assertTrue(self.submit(self.report(101, str(uuid.uuid4())))['qualified'])
        self.assertEqual([entry['name'] for entry in first['entries']], ['same'] * 10)

    def test_fastest_completion_ties_do_not_displace_existing_times(self):
        self.publish_spec(games.word_games().default_spec('word-search'))
        won = self.result()
        for index in range(10): self.submit_result({**won, 'elapsed': index + 1})
        self.assertFalse(self.submit_result({**won, 'elapsed': 10})['qualified'])
        self.assertFalse(self.submit_result({**won, 'elapsed': 11})['qualified'])
        self.assertTrue(self.submit_result({**won, 'elapsed': 0.5})['qualified'])
        self.assertEqual([entry['elapsed'] for entry in self.get()['entries']], [0.5] + list(range(1, 10)))

    def test_displayed_attempt_remains_idempotent_after_receipt_eviction(self):
        body = self.report(10000, name='first')
        first = self.submit(body)
        for index in range(scores.MAX_RECEIPTS + 1): self.submit(self.report(0, str(uuid.uuid4())))
        stored = json.loads(self.stored_board()['payload'])
        self.assertNotIn(fixtures.REQUEST, [receipt['id'] for receipt in stored['receipts']])
        count = self.database.meta.client.transact_write_items.call_count
        self.assertTrue(self.submit(body)['qualified'])
        self.assertEqual(self.database.meta.client.transact_write_items.call_count, count)
        self.error(409, lambda: self.submit({**body, 'name': 'changed'}))
        self.assertEqual(self.get()['entries'][0], first['entries'][0])

    def test_legacy_point_entries_keep_long_names_owner_and_missing_elapsed(self):
        owner = hashlib.sha256(b'synthetic old account').hexdigest()
        entry = {'owner': owner, 'name': 'LEGACYPLAYER1234', 'points': 100, 'createdAt': '2026-10-01T12:00:00+00:00'}
        state = {'publishedRevision': self.revision, 'entries': [entry], 'receipts': []}
        item = scores.envelope('game-score', fixtures.GAME, state, None)
        self.database.rows['published-games'][item['id']] = item
        before = deepcopy(self.database.rows)
        public = self.get()
        self.assertEqual(self.database.rows, before)
        self.assertEqual(public['entries'], [{key: value for key, value in entry.items() if key != 'owner'}])
        board = self.submit(self.report(200, fixtures.SECOND, 'new'))
        self.assertNotIn('owner', json.dumps(board))
        legacy = json.loads(self.stored_board()['payload'])['entries'][1]
        self.assertEqual(legacy, entry)
        self.error(400, lambda: self.submit(self.report(300, str(uuid.uuid4()), entry['name'])))

    def test_admission_uses_one_fixed_rate_row_and_hashes_only_trusted_source(self):
        event = {'headers': {'x-forwarded-for': 'untrusted'}, 'requestContext': {'http': {'sourceIp': '192.0.2.8'}}}
        with patch.object(scores.time, 'time', return_value=120):
            self.submit_result(self.result(), event=event)
            key = scores.key('game-score-rate', '')
            first = json.loads(self.database.rows['published-games'][key]['payload'])
            self.assertEqual(first['count'], 1); self.assertEqual(first['minute'], 2)
            self.assertNotIn('192.0.2.8', json.dumps(self.database.rows)); self.assertNotIn('untrusted', json.dumps(self.database.rows))
            expected = hashlib.sha256((scores.key('score-source', '2') + ':192.0.2.8').encode()).hexdigest()
            self.assertEqual(first['sources'], {expected: 1})
        with patch.object(scores.time, 'time', return_value=180):
            self.submit_result(self.result(), event=event)
            current = json.loads(self.database.rows['published-games'][key]['payload'])
            self.assertEqual(current['count'], 1); self.assertEqual(current['minute'], 3)
            self.assertNotIn(expected, current['sources'])
        self.assertEqual(sum(key.startswith('game-score-rate:') for key in self.database.rows['published-games']), 1)

    def seed_rate(self, sources, count=None, minute=2):
        state = {'minute': minute, 'count': sum(sources.values()) if count is None else count, 'sources': sources}
        item = scores.envelope('game-score-rate', '', state, None)
        self.database.rows['published-games'][item['id']] = item

    def test_per_source_installation_and_source_map_limits_preserve_all_records(self):
        with patch.object(scores.time, 'time', return_value=120):
            source = hashlib.sha256((scores.key('score-source', '2') + ':unknown').encode()).hexdigest()
            cases = [{source: 120}, {hashlib.sha256(str(i).encode()).hexdigest(): 120 for i in range(5)}, {hashlib.sha256(str(i).encode()).hexdigest(): 1 for i in range(128)}]
            for sources in cases:
                self.seed_rate(sources); before = deepcopy(self.database.rows)
                self.error(429, self.submit)
                self.assertEqual(self.database.rows, before)
                self.assertNotIn(scores.key('game-score', fixtures.GAME), self.database.rows['published-games'])

    def test_known_retry_bypasses_new_attempt_rate_limit_without_writing(self):
        with patch.object(scores.time, 'time', return_value=120):
            first = self.submit()
            rate_key = scores.key('game-score-rate', '')
            row = self.database.rows['published-games'][rate_key]
            rate = json.loads(row['payload']); rate['count'] = 120; rate['sources'] = {next(iter(rate['sources'])): 120}; row['payload'] = scores.canonical(rate)
            before = deepcopy(self.database.rows)
            self.assertEqual(self.submit(), first)
            self.assertEqual(self.database.rows, before)
            self.error(429, lambda: self.submit(self.report(request=fixtures.SECOND)))

    def test_same_revision_publication_payload_change_is_fenced_atomically(self):
        def change_snapshot():
            row = self.database.rows['published-games'][games.key('game', fixtures.GAME)]
            payload = json.loads(row['payload']); payload['spec']['title'] = 'Concurrent edition metadata'; row['payload'] = json.dumps(payload)
        self.race_once(change_snapshot)
        self.error(409, self.submit)
        self.assertNotIn(scores.key('game-score', fixtures.GAME), self.database.rows['published-games'])
        self.assertNotIn(scores.key('game-score-rate', ''), self.database.rows['published-games'])

    def test_publication_payload_change_during_read_does_not_return_a_stale_board(self):
        self.submit(); original = scores.board_state
        def change_on_read(*args):
            result = original(*args)
            row = self.database.rows['published-games'][games.key('game', fixtures.GAME)]
            value = json.loads(row['payload']); value['spec']['title'] = 'Changed title'; row['payload'] = json.dumps(value)
            return result
        with patch.object(scores, 'board_state', side_effect=change_on_read): self.error(409, self.get)

    def test_unknown_cancellation_failure_is_not_misreported_as_retry(self):
        class StorageError(Exception):
            response = {'Error': {'Code': 'TransactionCanceledException'}, 'CancellationReasons': [{'Code': 'ValidationError'}]}
        before = deepcopy(self.database.rows)
        with patch.object(self.database.meta.client, 'transact_write_items', side_effect=StorageError):
            with self.assertRaises(StorageError): self.submit()
        self.assertEqual(self.database.rows, before)

    def multi_fixture(self, child_flow=False):
        spec = games.default_multi_game()
        spec['steps'].insert(1, {'id': 'step-3', 'type': 'material', 'title': 'Client object', 'kind': 'interactive', 'reference': 'client:one', 'required': True})
        spec['steps'].append({'id': 'step-4', 'type': 'free-play', 'spec': games.design_game('Asteroids with endless survival.')['spec']})
        if child_flow:
            child = games.create_platformer_spec()
            child['flow'] = {'version': 1, 'nodes': [{'id': 'step-1', 'type': 'level', 'levelId': 'level-2'}, {'id': 'step-4', 'type': 'material', 'title': 'Client material', 'kind': 'lesson', 'reference': 'client:inner', 'required': True}, {'id': 'step-2', 'type': 'level', 'levelId': 'level-1'}, {'id': 'step-3', 'type': 'level', 'levelId': 'level-3'}]}
            spec['steps'][0]['spec'] = child
        spec = self.publish_spec(spec)
        observations = []
        for step in spec['steps']:
            if step['type'] != 'game': continue
            result = self.result(step['spec'])
            observation = {'stepId': step['id'], 'result': result}
            if 'flow' in step['spec']:
                observation['flow'] = {'runId': fixtures.REQUEST, 'status': 'won', 'completedLevelIds': result['reviewedLevelIds'], 'materials': [{'nodeId': 'step-4', 'status': 'completed', 'elapsed': 2}], 'gameplayElapsed': result['elapsed'], 'wallElapsed': result['elapsed'] + 2, 'score': result['score'], 'points': result['points']}
            observations.append(observation)
        elapsed = sum(item['result']['elapsed'] for item in observations)
        result = {'outcome': 'won', 'elapsed': elapsed, 'wallElapsed': elapsed + 2 + (2 if child_flow else 0), 'score': sum(item['result']['score'] for item in observations), 'points': sum(item['result'].get('points', item['result']['score'] * 10) for item in observations), 'games': observations, 'materials': [{'path': ['step-3'], 'status': 'completed', 'elapsed': 2}]}
        return spec, result

    def test_multi_game_uses_existing_finite_points_and_excludes_free_play(self):
        spec, result = self.multi_fixture()
        board = self.submit_result(result)
        self.assertEqual(board['ranking'], 'points'); self.assertEqual(board['entries'][0]['points'], result['points'])
        self.assertEqual(board['entries'][0]['elapsed'], result['elapsed'])
        for change in [lambda value: value.update(points=value['points'] + 1), lambda value: value['games'].reverse(), lambda value: value['games'].append({'stepId': 'step-4', 'result': self.result(spec['steps'][-1]['spec'], 'lost')}), lambda value: value['materials'][0].update(status='skipped'), lambda value: value['materials'][0].update(path=['step-3', 'step-4']), lambda value: value['materials'].clear(), lambda value: value.update(wallElapsed=0), lambda value: value.update(identity='not-allowed')]:
            invalid = deepcopy(result); change(invalid)
            self.error(400, lambda: self.submit_result(invalid))

    def test_multi_game_child_flows_require_exact_order_totals_and_required_material(self):
        _, result = self.multi_fixture(child_flow=True)
        self.assertTrue(self.submit_result(result)['qualified'])
        for change in [lambda value: value['games'][0].pop('flow'), lambda value: value['games'][0]['flow']['materials'][0].update(status='skipped'), lambda value: value['games'][0]['flow']['completedLevelIds'].reverse(), lambda value: value['games'][0]['flow'].update(points=1), lambda value: value['games'][0]['flow'].update(wallElapsed=10), lambda value: value['games'][0]['flow'].update(runId='not-a-run')]:
            invalid = deepcopy(result); change(invalid)
            self.error(400, lambda: self.submit_result(invalid))

    def test_cooperative_advanced_caps_cover_each_completed_level_without_loosening_solo(self):
        spec = games.design_game('Asteroids with three levels and enemy ships.')['spec']
        spec['multiplayer'] = {'mode': 'cooperative', 'maxPlayers': 2}
        self.publish_spec(spec)
        levels = games.get_levels(spec)
        report = {'outcome': 'lost', 'elapsed': 2, 'score': levels[0]['rules']['goal'], 'reviewedLevelIds': [level['id'] for level in levels[:2]], 'points': 8001}
        self.assertEqual(scores.validate_result(report, spec), report)
        self.error(400, lambda: scores.validate_result({**report, 'points': 8002}, spec))
        self.error(400, lambda: scores.validate_result({**report, 'score': 0}, spec))
        solo = deepcopy(spec); solo.pop('multiplayer')
        self.error(400, lambda: scores.validate_result(report, solo))

    def test_installation_rate_race_across_different_games_is_atomic(self):
        other = self.publish(self.finish_test(self.create(game=fixtures.COPY, prompt='Asteroids.')))
        def submit_other():
            body = self.report(200, fixtures.SECOND); body['publishedRevision'] = other['publishedRevision']
            scores.submit_score(self.api, {}, fixtures.COPY, body)
        self.race_once(submit_other)
        self.error(409, self.submit)
        self.assertNotIn(scores.key('game-score', fixtures.GAME), self.database.rows['published-games'])
        self.assertEqual(scores.get_scores(self.api, fixtures.COPY, other['publishedRevision'])['entries'][0]['points'], 200)
        rate = json.loads(self.database.rows['published-games'][scores.key('game-score-rate', '')]['payload'])
        self.assertEqual(rate['count'], 1)

    def test_public_catalog_can_advance_past_the_fixed_private_rate_row(self):
        with patch.object(scores.time, 'time', return_value=120): self.submit()
        rate = self.database.rows['published-games'][scores.key('game-score-rate', '')]
        public = self.database.rows['published-games'][games.key('game', fixtures.GAME)]
        pages = [{'Items': [deepcopy(rate)], 'LastEvaluatedKey': {'id': rate['id']}}, {'Items': [deepcopy(public)]}]
        with patch.object(self.database.table_class, 'scan', side_effect=pages) as scan:
            first = games.list_games(self.api, None, {}, True)
            self.assertEqual(first['games'], []); self.assertIn('cursor', first)
            second = games.list_games(self.api, None, {'queryStringParameters': {'cursor': first['cursor']}}, True)
            self.assertEqual([item['id'] for item in second['games']], [fixtures.GAME])
            self.assertEqual(scan.call_args.kwargs['ExclusiveStartKey'], {'id': rate['id']})
            self.assertNotIn('sources', json.dumps(first)); self.assertNotIn('sources', json.dumps(second))
        invalid = base64.urlsafe_b64encode(json.dumps({'id': rate['id'] + 'not-empty'}).encode()).decode()
        self.error(400, lambda: games.list_games(self.api, None, {'queryStringParameters': {'cursor': invalid}}, True))
        self.error(400, lambda: games.list_games(self.api, self.claims, {'queryStringParameters': {'cursor': first['cursor']}}, False))

    def test_nonfinite_numbers_booleans_and_extra_result_fields_never_write(self):
        original = self.report()['result']
        for change in [{'elapsed': 10 ** 1000}, {'elapsed': float('nan')}, {'points': True}, {'score': False}, {'elapsed': 1, 'tenant': fixtures.OTHER}]:
            self.error(400, lambda: self.submit_result({**original, **change}))
        self.assertNotIn(scores.key('game-score', fixtures.GAME), self.database.rows['published-games'])
        self.assertNotIn(scores.key('game-score-rate', ''), self.database.rows['published-games'])


if __name__ == '__main__': unittest.main()
