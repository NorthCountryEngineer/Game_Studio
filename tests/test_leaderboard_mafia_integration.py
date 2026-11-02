"""Mixed-table leaderboard/Mafia regression checks using synthetic records only."""
from copy import deepcopy
import base64
import importlib.util
import json
from pathlib import Path
import types
import unittest
from unittest.mock import patch

import test_game_scores as scoring
from test_nce_api import ConditionalFailure, MemoryTable

scores, games, fixtures = scoring.scores, scoring.games, scoring.support
module = importlib.util.spec_from_file_location('leaderboard_mafia_integration', Path(__file__).parents[1] / 'backend/nce_api/mafia.py')
mafia = importlib.util.module_from_spec(module)
module.loader.exec_module(mafia)


class LeaderboardMafiaIntegrationTests(unittest.TestCase):
    authorize = fixtures.GameTests.authorize
    event = fixtures.GameTests.event
    create = fixtures.GameTests.create
    finish_test = fixtures.GameTests.finish_test
    publish = fixtures.GameTests.publish
    report = scoring.ScoreTests.report
    submit = scoring.ScoreTests.submit

    def setUp(self):
        scoring.ScoreTests.setUp(self)
        self.database.meta.client.exceptions = types.SimpleNamespace(TransactionCanceledException=ConditionalFailure)
        self.room_id = '99999999-9999-4999-8999-999999999999'
        self.admission = {'requestId': self.room_id, 'name': 'RoomHost', 'avatar': 'fox',
            'playerToken': 'P' * 43, 'inviteToken': 'I' * 43, 'narratorMode': 'human'}
        self.room = mafia.dispatch(self.api, {'headers': {}, 'requestContext': {'http': {'sourceIp': '203.0.113.15'}}},
            'POST', '/mafia/rooms', self.admission)
        self.narration_key = mafia.key('game-mafia-narration')
        # Internal rows must be skipped before their private payload is decoded.
        self.database.rows['published-games'][self.narration_key] = {
            'id': self.narration_key, 'revision': 1, 'organization_id': fixtures.ORG,
            'service_id': fixtures.SERVICE, 'payload': 'never-public-narration-not-json'}
        self.submitted = self.submit()

    def cursor(self, identifier, **extra):
        return base64.urlsafe_b64encode(json.dumps({'id': identifier, **extra}).encode()).decode()

    def catalog(self, cursor=None, public=True):
        query = {'specVersion': 'all'} if public else {}
        if cursor is not None:
            query['cursor'] = cursor
        return games.list_games(self.api, None if public else self.claims,
            {'queryStringParameters': query}, public=public)

    def internal_rows(self):
        return [deepcopy(self.database.rows['published-games'][identifier]) for identifier in (
            scores.key('game-score-rate', ''), scores.key('game-score', fixtures.GAME),
            mafia.key('game-mafia-room', self.room_id), mafia.key('game-mafia-index'), self.narration_key)]

    def assert_public_only(self, result):
        wire = json.dumps(result)
        for private in ('never-public', 'tokenHash', 'inviteHash', 'createFingerprint', 'members',
                        'sources', 'fingerprint', 'receipts', 'nightActions', 'mafiaChat'):
            self.assertNotIn(private, wire)
        self.assertNotIn(self.admission['playerToken'], wire)
        self.assertNotIn(self.admission['inviteToken'], wire)

    def assert_cursor_error(self, cursor, public=True):
        with self.assertRaises(games.GameError) as caught:
            self.catalog(cursor, public=public)
        self.assertEqual(caught.exception.status, 400)

    def test_mixed_public_table_projects_only_games_without_decoding_private_rows(self):
        before = deepcopy(self.database.rows)
        result = self.catalog()
        self.assertEqual([game['id'] for game in result['games']], [fixtures.GAME])
        self.assert_public_only(result)
        self.assertEqual(self.database.rows, before)
        self.authorization.assert_not_called()
        self.provider.converse.assert_not_called()

    def test_filtered_pages_continue_across_score_rate_board_and_every_mafia_kind(self):
        internals = self.internal_rows()
        published = deepcopy(self.database.rows['published-games'][games.key('game', fixtures.GAME)])
        pages = [{'Items': [row], 'LastEvaluatedKey': {'id': row['id']}} for row in internals]
        pages.append({'Items': [published]})
        with patch.object(MemoryTable, 'scan', side_effect=pages) as scan:
            cursor = None
            results = []
            for index in range(len(pages)):
                page = self.catalog(cursor)
                self.assert_public_only(page)
                if index < len(internals):
                    self.assertEqual(page['games'], [])
                    self.assertEqual(json.loads(base64.urlsafe_b64decode(page['cursor'])), {'id': internals[index]['id']})
                results.extend(page['games'])
                cursor = page.get('cursor')
            self.assertIsNone(cursor)
            self.assertEqual([game['id'] for game in results], [fixtures.GAME])
            self.assertNotIn('ExclusiveStartKey', scan.call_args_list[0].kwargs)
            for index, row in enumerate(internals, start=1):
                self.assertEqual(scan.call_args_list[index].kwargs['ExclusiveStartKey'], {'id': row['id']})

    def test_internal_cursor_suffixes_are_exact_and_never_valid_for_private_archive(self):
        kinds = [('game-score-rate', ''), ('game-score', fixtures.GAME),
                 ('game-mafia-room', self.room_id), ('game-mafia-index', ''), ('game-mafia-narration', '')]
        for kind, suffix in kinds:
            valid_key = games.key(kind, suffix)
            with self.subTest(kind=kind):
                encoded = self.cursor(valid_key)
                with patch.object(MemoryTable, 'scan', return_value={'Items': []}) as scan:
                    self.assertEqual(self.catalog(encoded), {'games': []})
                    self.assertEqual(scan.call_args.kwargs['ExclusiveStartKey'], {'id': valid_key})
                self.assert_cursor_error(encoded, public=False)
                invalid_suffixes = ('', 'not-a-uuid', fixtures.GAME + ':extra') if suffix else (fixtures.GAME, 'not-empty', ':')
                for invalid in invalid_suffixes:
                    self.assert_cursor_error(self.cursor(games.key(kind, invalid)))
                self.assert_cursor_error(self.cursor(valid_key, private=True))
        for private_kind in ('game-config', 'integration-config', 'session', 'feedback'):
            self.assert_cursor_error(self.cursor(games.key(private_kind, '')))

    def test_scan_positions_from_another_scope_never_authorize_their_payloads(self):
        foreign_id = ':'.join(['game-mafia-room', fixtures.OTHER, fixtures.SERVICE, self.room_id])
        foreign = {'id': foreign_id, 'organization_id': fixtures.OTHER, 'service_id': fixtures.SERVICE,
            'payload': 'never-public-foreign-not-json'}
        current = deepcopy(self.database.rows['published-games'][games.key('game', fixtures.GAME)])
        with patch.object(MemoryTable, 'scan', side_effect=[
                {'Items': [foreign], 'LastEvaluatedKey': {'id': foreign_id}}, {'Items': [foreign, current]}]) as scan:
            first = self.catalog()
            self.assertEqual(first['games'], [])
            second = self.catalog(first['cursor'])
            self.assertEqual([game['id'] for game in second['games']], [fixtures.GAME])
            self.assert_public_only(first); self.assert_public_only(second)
            self.assertEqual(scan.call_args.kwargs['ExclusiveStartKey'], {'id': foreign_id})
        self.assert_cursor_error(self.cursor(':'.join(['game-mafia-room', 'not-a-tenant', fixtures.SERVICE, self.room_id])))

    def test_score_write_and_exact_replay_leave_all_mafia_rows_unchanged(self):
        mafia_before = {key: deepcopy(row) for key, row in self.database.rows['published-games'].items() if key.startswith('game-mafia-')}
        report = self.report(points=120, request=fixtures.SECOND, name='New🙂')
        result = self.submit(report)
        self.assertTrue(result['qualified'])
        after_first = deepcopy(self.database.rows)
        retry = self.submit(deepcopy(report))
        self.assertEqual(retry, result)
        self.assertEqual(self.database.rows, after_first)
        self.assertEqual({key: row for key, row in self.database.rows['published-games'].items() if key.startswith('game-mafia-')}, mafia_before)
        resumed = mafia.dispatch(self.api, {'headers': {'authorization': 'Bearer ' + self.admission['playerToken']}},
            'GET', '/mafia/rooms/' + self.room_id, {})
        self.assertEqual(resumed['room']['self']['id'], self.room_id)
        self.assertTrue(resumed['room']['self']['isNarrator'])
        self.authorization.assert_not_called()
        self.provider.converse.assert_not_called()


if __name__ == '__main__':
    unittest.main()
