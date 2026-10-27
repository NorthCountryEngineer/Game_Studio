"""Offline shared-board tests: authenticated writes, public projections, editions and CAS."""
from copy import deepcopy
import importlib.util
import json
import math
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
import uuid

import test_games as support

games = support.games
module = importlib.util.spec_from_file_location('scores_test_module', Path(__file__).parents[1] / 'backend/nce_api/game_scores.py')
scores = importlib.util.module_from_spec(module); module.loader.exec_module(scores)


class ScoreTests(unittest.TestCase):
    setUp = support.GameTests.setUp
    authorize = support.GameTests.authorize
    event = support.GameTests.event
    create = support.GameTests.create
    finish_test = support.GameTests.finish_test
    publish = support.GameTests.publish
    stored = support.GameTests.stored
    race_once = support.GameTests.race_once

    def setUp(self):
        support.GameTests.setUp(self)
        self.published = self.publish(self.finish_test(self.create(prompt='Asteroids with three levels.')))
        self.revision = self.published['publishedRevision']

    def error(self, status, fn):
        with self.assertRaises((scores.ScoreError, games.GameError)) as caught: fn()
        self.assertEqual(caught.exception.status, status)

    def report(self, points=100, request=support.REQUEST, name='tiny', **changes):
        value = {'publishedRevision': self.revision, 'requestId': request, 'name': name,
            'result': {'outcome': 'lost', 'elapsed': 10, 'score': 0, 'reviewedLevelIds': ['level-1'], 'points': points}}
        value.update(changes)
        return value

    def submit(self, body=None):
        return scores.dispatch(self.api, self.event(), 'POST', '/game-scores/' + support.GAME,
            self.report() if body is None else body)

    def get(self, revision=None):
        return scores.dispatch(self.api, {'queryStringParameters': {'revision': str(self.revision if revision is None else revision)}},
            'GET', '/game-scores/' + support.GAME, {})

    def stored_board(self):
        return self.database.rows['published-games'][games.key('game-score', support.GAME)]

    def test_cooperative_enabled_edition_cannot_write_to_a_solo_scoreboard(self):
        saved = games.update(self.api, self.claims, support.GAME, {
            'revision': self.published['revision'], 'spec': {**self.published['spec'],
            'version': 4, 'multiplayer': {'mode': 'cooperative', 'maxPlayers': 2}}})
        published = self.publish(self.finish_test(saved))
        self.revision = published['publishedRevision']
        self.error(404, self.get)
        self.error(404, self.submit)
        self.assertNotIn(games.key('game-score', support.GAME), self.database.rows['published-games'])

    def test_solo_prizes_accept_bounded_scores_but_cooperative_prizes_cannot_enter_solo_board(self):
        spec = {**self.published['spec'], 'version': 5, 'powerUps': {
            'spawnInterval': 12, 'duration': 10, 'types': ['triple-shot', 'rapid-fire', 'shield', 'speed-boost']}}
        saved = games.update(self.api, self.claims, support.GAME, {'revision': self.published['revision'], 'spec': spec})
        published = self.publish(self.finish_test(saved))
        self.revision = published['publishedRevision']
        self.assertEqual(self.submit()['entries'][0]['points'], 100)
        spec['multiplayer'] = {'mode': 'cooperative', 'maxPlayers': 2}
        saved = games.update(self.api, self.claims, support.GAME, {'revision': self.revision, 'spec': spec})
        published = self.publish(self.finish_test(saved))
        self.revision = published['publishedRevision']
        self.error(404, self.get)
        self.error(404, self.submit)

    def test_public_board_is_readable_without_authorization_and_projects_only_safe_fields(self):
        empty = self.get()
        self.assertEqual(empty, {'scope': 'shared', 'publishedRevision': self.revision, 'limit': 10, 'entries': []})
        self.authorization.assert_not_called()
        shared = self.submit()
        self.authorization.reset_mock()
        self.assertEqual(self.get(), shared); self.authorization.assert_not_called()
        self.assertEqual(set(shared), {'scope', 'publishedRevision', 'limit', 'entries'})
        self.assertEqual(set(shared['entries'][0]), {'name', 'points', 'createdAt'})
        encoded = json.dumps(shared)
        for value in [support.USER, support.REQUEST, 'owner', 'receipts', 'fingerprint', 'permissions']:
            self.assertNotIn(value, encoded)
        stored = json.loads(self.stored_board()['payload'])
        self.assertEqual(set(stored['entries'][0]), {'owner', 'name', 'points', 'createdAt'})
        self.assertRegex(stored['entries'][0]['owner'], r'^[0-9a-f]{64}$')
        self.assertNotIn(support.USER, self.stored_board()['payload'])
        self.provider.converse.assert_not_called()

    def test_every_write_freshly_authorizes_app_members_without_editor_permissions(self):
        self.claims['permissions'] = []
        value = self.submit()
        self.assertEqual(value['entries'][0]['points'], 100)
        self.authorization.assert_called_once_with(self.event())
        self.submit(self.report(110, support.SECOND))
        self.assertEqual(self.authorization.call_count, 2)
        self.error(401, lambda: scores.dispatch(self.api, {}, 'POST', '/game-scores/' + support.GAME, self.report()))
        self.assertEqual(len(json.loads(self.stored_board()['payload'])['entries']), 1)
        self.authorization.side_effect = games.GameError(403, 'Application access revoked.')
        self.error(403, lambda: self.submit(self.report(200, str(uuid.uuid4()))))
        self.assertEqual(self.get()['entries'][0]['points'], 110)

    def test_player_session_does_not_grant_editor_access_or_expose_identity(self):
        for permissions in [[], ['games-create'], ['games-publish']]:
            self.claims['permissions'] = permissions
            self.assertEqual(scores.dispatch(self.api, self.event(), 'GET', '/game-scores/session', {}),
                {'authenticated': True, 'canEdit': 'games-create' in permissions})
            self.authorization.assert_called_with(self.event())
        self.error(401, lambda: scores.dispatch(self.api, {}, 'GET', '/game-scores/session', {}))

    def test_packaged_handler_routes_score_reads_and_current_player_sessions(self):
        import test_nce_api
        handler = test_nce_api.api
        with patch.object(handler, '_game_scores', scores), patch.object(handler, 'clients', self.api.clients), patch.object(handler, 'authorize', self.authorization):
            event = {**self.event(), 'requestContext': {'http': {'method': 'GET'}}, 'rawPath': '/game-scores/session'}
            response = handler.handler(event, None)
            self.assertEqual(response['statusCode'], 200)
            self.assertEqual(json.loads(response['body']), {'authenticated': True, 'canEdit': True})
            self.authorization.reset_mock()
            event.update(rawPath='/game-scores/' + support.GAME, queryStringParameters={'revision': str(self.revision)})
            self.assertEqual(handler.handler(event, None)['statusCode'], 200)
            self.authorization.assert_not_called()
            event['queryStringParameters']['revision'] = '0'
            self.assertEqual(handler.handler(event, None)['statusCode'], 400)

    def test_invalid_subject_cannot_write_even_after_a_malformed_authorization_response(self):
        for subject in [None, True, '', 'not-a-core-subject', [support.USER]]:
            self.claims['sub'] = subject
            self.error(401, self.submit)
        self.assertNotIn(games.key('game-score', support.GAME), self.database.rows['published-games'])

    def test_private_missing_foreign_and_nonarcade_games_never_publish_a_board(self):
        self.create(game=support.COPY, prompt='Asteroids')
        self.error(404, lambda: scores.get_scores(self.api, support.COPY, 2))
        self.error(404, lambda: scores.submit_score(self.api, self.claims, support.COPY, self.report()))
        for game in [support.OTHER, support.SECOND]: self.error(404, lambda: scores.get_scores(self.api, game, self.revision))
        row = self.database.rows['published-games'][games.key('game', support.GAME)]
        row['organization_id'] = support.OTHER
        self.error(404, self.get); self.error(404, self.submit)
        row['organization_id'] = support.ORG; row['service_id'] = support.OTHER
        self.error(404, self.get)
        row['service_id'] = support.SERVICE
        source = json.loads(row['payload'])
        for mutate in [lambda value: value['spec'].pop('arcade'),
                lambda value: value['spec']['arcade'].update(highScores=False),
                lambda value: value['spec']['arcade'].update(scoring=False, highScores=False)]:
            changed = deepcopy(source); mutate(changed); row['payload'] = json.dumps(changed)
            self.error(404, self.get); self.error(404, self.submit)
        self.assertNotIn(games.key('game-score', support.GAME), self.database.rows['published-games'])

    def test_names_are_bounded_arcade_labels_not_html_links_or_contact_fields(self):
        self.assertEqual(scores.validate_name(' tiny  axo '), 'TINY AXO')
        self.assertEqual(scores.validate_name('A_1-B'), 'A_1-B')
        self.assertEqual(scores.validate_name('a' * 16), 'A' * 16)
        for invalid in ['', ' ', 'a' * 17, 'éclair', '🦎', '<b>hi</b>', 'https://x.y', 'a@b.com', 'a\nb', 'a\tb',
                'A\x80B', 1, True, None, [], {}]:
            self.error(400, lambda: self.submit(self.report(name=invalid)))
        self.assertEqual(self.submit(self.report(name=' tiny  axo '))['entries'][0]['name'], 'TINY AXO')

    def test_fields_ids_edition_and_names_are_strict_before_any_board_write(self):
        for field in ['publishedRevision', 'requestId', 'name', 'result']:
            body = self.report(); body.pop(field)
            self.error(400, lambda: self.submit(body))
        self.error(400, lambda: self.submit({**self.report(), 'owner': support.OTHER}))
        self.error(400, lambda: self.submit({**self.report(), 'permissions': ['admin']}))
        for revision in [0, -1, True, None, '2', 2.0, 1000000001]:
            self.error(400, lambda: self.submit(self.report(publishedRevision=revision)))
        for request in ['bad', support.REQUEST.upper(), '', 1, None, []]:
            # A digits-only UUID is unchanged by upper(); use actual letters here.
            if request == support.REQUEST: continue
            self.error(400, lambda: self.submit(self.report(request=request)))
        self.error(400, lambda: self.submit(self.report(request='AAAAaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')))
        self.assertNotIn(games.key('game-score', support.GAME), self.database.rows['published-games'])

    def test_only_positive_terminal_bounded_reports_are_accepted(self):
        original = self.report()['result']
        mutations = [
            {}, None, [], {**original, 'extra': 1}, {key: value for key, value in original.items() if key != 'points'},
            *[{**original, 'outcome': outcome} for outcome in ['playing', 'level-complete', True, None, []]],
            *[{**original, 'points': points} for points in [0, -1, 1.5, True, '100', None, math.inf, math.nan, 99999999]],
            *[{**original, 'score': score} for score in [-1, True, 1.5, '1', 1000]],
            *[{**original, 'elapsed': elapsed} for elapsed in [0, -1, True, '10', None, math.inf, math.nan, 100000]],
        ]
        for result in mutations: self.error(400, lambda: self.submit(self.report(result=result)))
        self.assertNotIn(games.key('game-score', support.GAME), self.database.rows['published-games'])
        spec = self.published['spec']; played = games.get_levels(spec)[:1]
        maximum = scores.max_points(spec, played)
        self.assertEqual(self.submit(self.report(points=maximum))['entries'][0]['points'], maximum)
        self.error(400, lambda: self.submit(self.report(points=maximum + 1, request=support.SECOND)))

    def test_level_order_collection_progress_and_complete_win_are_version_bound(self):
        spec = self.published['spec']; levels = games.get_levels(spec)
        original = self.report()['result']
        for ids in [[], ['level-2'], ['level-1', 'level-3'], ['level-1', 'level-1'], ['level-1', 'level-2', 'level-3', 'level-4'],
                'level-1', None, [1], [True]]:
            self.error(400, lambda: self.submit(self.report(result={**original, 'reviewedLevelIds': ids})))
        self.error(400, lambda: self.submit(self.report(result={**original, 'outcome': 'won'})))
        completed = sum(level['rules']['goal'] for level in levels)
        victory = {**original, 'outcome': 'won', 'score': completed, 'reviewedLevelIds': [level['id'] for level in levels]}
        self.assertEqual(self.submit(self.report(result=victory))['entries'][0]['points'], 100)
        for change in [{'score': completed - 1}, {'reviewedLevelIds': ['level-1']}, {'elapsed': 1000}]:
            self.error(400, lambda: self.submit(self.report(request=str(uuid.uuid4()), result={**victory, **change})))
        previous_goal = levels[0]['rules']['goal']
        self.error(400, lambda: self.submit(self.report(request=support.SECOND, result={**original,
            'reviewedLevelIds': ['level-1', 'level-2'], 'score': previous_goal - 1})))
        self.submit(self.report(request=support.SECOND, result={**original,
            'reviewedLevelIds': ['level-1', 'level-2'], 'score': previous_goal}))

    def test_request_identity_is_owner_and_content_bound_and_retries_do_not_write_twice(self):
        first = self.submit(); count = self.database.meta.client.transact_write_items.call_count
        retry = self.submit(); self.assertEqual(first, retry)
        self.assertEqual(self.database.meta.client.transact_write_items.call_count, count)
        self.assertEqual(self.submit(self.report(name='TINY')), first)
        for body in [self.report(points=200), self.report(name='someone'), self.report(result={**self.report()['result'], 'elapsed': 11})]:
            self.error(409, lambda: self.submit(body))
        self.claims['sub'] = support.OTHER
        self.assertEqual(len(self.submit()['entries']), 2)

    def test_top_ten_is_one_personal_best_per_account_and_lesser_scores_do_not_rename_it(self):
        first = self.submit(self.report(100, name='first'))
        best = self.submit(self.report(200, support.SECOND, 'best'))
        self.assertEqual(len(best['entries']), 1); self.assertEqual(best['entries'][0]['name'], 'BEST')
        self.assertEqual(self.submit(self.report(150, str(uuid.uuid4()), 'lower'))['entries'], best['entries'])
        self.assertEqual(self.submit(self.report(200, str(uuid.uuid4()), 'equal'))['entries'], best['entries'])
        for index in range(1, 13):
            self.claims['sub'] = str(uuid.UUID(int=index))
            self.submit(self.report(200 + index * 10, str(uuid.uuid4()), f'AXO-{index}'))
        board = self.get()
        self.assertEqual(len(board['entries']), 10)
        self.assertEqual([entry['points'] for entry in board['entries']], list(range(320, 220, -10)))
        self.assertEqual(len(json.loads(self.stored_board()['payload'])['entries']), 10)
        self.assertEqual(first['entries'][0]['name'], 'FIRST')

    def test_receipts_have_a_fixed_limit_and_never_accumulate_unbounded_storage(self):
        for index in range(scores.MAX_RECEIPTS + 5):
            self.submit(self.report(100 + index, str(uuid.uuid4())))
        stored = json.loads(self.stored_board()['payload'])
        self.assertEqual(len(stored['receipts']), scores.MAX_RECEIPTS)
        self.assertEqual(len(stored['entries']), 1)
        self.assertLess(len(self.stored_board()['payload'].encode()), 80000)

    def test_published_editions_reset_boards_and_old_tabs_cannot_resubmit(self):
        old_body = self.report(); self.submit(old_body)
        revised = games.complete_test(self.api, self.claims, support.GAME, {'revision': self.revision,
            'reviewedLevelIds': [level['id'] for level in self.published['spec']['levels']]})
        updated = self.publish(revised)
        self.error(409, self.get); self.error(409, lambda: self.submit(old_body))
        self.revision = updated['publishedRevision']
        self.assertEqual(self.get()['entries'], [])
        self.assertEqual(self.submit(self.report(50))['entries'][0]['points'], 50)
        self.assertEqual(json.loads(self.stored_board()['payload'])['publishedRevision'], self.revision)

    def test_board_rows_are_scope_checked_even_if_the_key_matches(self):
        self.submit()
        stored = self.stored_board(); stored['organization_id'] = support.OTHER
        self.error(404, self.get); self.error(404, self.submit)
        stored['organization_id'] = support.ORG; stored['service_id'] = support.OTHER
        self.error(404, self.get); self.error(404, self.submit)

    def test_unpublish_delete_and_mid_read_removal_reject_boards_and_leave_no_names(self):
        self.submit()
        read_board = scores.board_state
        def remove_while_reading(*args):
            state = read_board(*args)
            games.publication(self.api, self.claims, support.GAME, {'revision': self.revision}, False)
            return state
        with patch.object(scores, 'board_state', side_effect=remove_while_reading): self.error(404, self.get)
        self.assertNotIn(games.key('game-score', support.GAME), self.database.rows['published-games'])
        self.error(404, self.submit)
        unpublished = games.load(self.api, self.claims, support.GAME)[0]
        self.published = self.publish(self.finish_test(unpublished)); self.revision = self.published['publishedRevision']
        self.submit()
        games.delete(self.api, self.claims, support.GAME, {'revision': self.revision})
        self.assertNotIn(games.key('game-score', support.GAME), self.database.rows['published-games'])
        self.error(404, self.get); self.error(404, self.submit)

    def test_removal_racing_submission_cannot_resurrect_a_board(self):
        self.race_once(lambda: games.delete(self.api, self.claims, support.GAME, {'revision': self.revision}))
        self.error(409, self.submit)
        self.assertNotIn(games.key('game', support.GAME), self.database.rows['published-games'])
        self.assertNotIn(games.key('game-score', support.GAME), self.database.rows['published-games'])

    def test_first_write_and_existing_board_races_preserve_the_winning_score(self):
        self.race_once(lambda: self.submit(self.report(200, support.SECOND)))
        self.error(409, self.submit)
        self.assertEqual(self.get()['entries'][0]['points'], 200)
        self.submit()
        self.race_once(lambda: self.submit(self.report(400, str(uuid.uuid4()))))
        self.error(409, lambda: self.submit(self.report(300, str(uuid.uuid4()))))
        self.assertEqual(self.get()['entries'][0]['points'], 400)

    def test_publication_racing_submission_rejects_the_old_revision(self):
        def republish():
            revised = self.finish_test(self.published)
            self.published = self.publish(revised)
        self.race_once(republish)
        self.error(409, self.submit)
        self.error(409, self.get)
        self.revision = self.published['publishedRevision']
        self.assertEqual(self.get()['entries'], [])

    def test_capacity_and_permission_errors_remain_errors_without_automatic_replay(self):
        class StorageError(Exception):
            def __init__(self, code, reasons=None):
                self.response = {'Error': {'Code': code}, **({'CancellationReasons': reasons} if reasons is not None else {})}
        for code, reasons in [('ProvisionedThroughputExceededException', None), ('AccessDeniedException', None),
                ('TransactionCanceledException', [{'Code': 'ProvisionedThroughputExceeded'}])]:
            with patch.object(self.database.meta.client, 'transact_write_items', side_effect=StorageError(code, reasons)) as call:
                with self.assertRaises(StorageError): self.submit()
                call.assert_called_once()
        for code, reasons in [('TransactionCanceledException', [{'Code': 'ConditionalCheckFailed'}, {'Code': 'None'}]),
                ('TransactionCanceledException', [{'Code': 'TransactionConflict'}])]:
            with patch.object(self.database.meta.client, 'transact_write_items', side_effect=StorageError(code, reasons)) as call:
                self.error(409, self.submit); call.assert_called_once()

    def test_routes_and_edition_queries_fail_closed_without_mutations(self):
        for path in ['/game-scores', '/game-scores/bad', '/game-scores/' + support.GAME + '/extra']:
            self.error(400 if path.endswith('bad') else 404,
                lambda: scores.dispatch(self.api, {}, 'GET', path, {}))
        self.error(404, lambda: scores.dispatch(self.api, {}, 'DELETE', '/game-scores/' + support.GAME, {}))
        for revision in ['', '0', '-1', ' 2', '2 ', '02', '2.0', '1e3', '10000000000', None, 2, []]:
            self.error(400, lambda: scores.dispatch(self.api, {'queryStringParameters': {'revision': revision}},
                'GET', '/game-scores/' + support.GAME, {}))
        self.assertNotIn(games.key('game-score', support.GAME), self.database.rows['published-games'])


if __name__ == '__main__': unittest.main()
