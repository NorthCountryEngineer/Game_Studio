"""Offline optional Asteroids schema, publication gates, and safe mixed archives."""
import base64
from copy import deepcopy
import json
import unittest
from unittest.mock import patch

import test_games as support

games = support.games
OPTIONS = {'rotation': True, 'shooting': True, 'splitAsteroids': True, 'scoring': True, 'highScores': True}


class ArcadeGameTests(unittest.TestCase):
    setUp = support.GameTests.setUp
    authorize = support.GameTests.authorize
    event = support.GameTests.event
    error = support.GameTests.error
    create = support.GameTests.create
    finish_test = support.GameTests.finish_test
    publish = support.GameTests.publish
    stored = support.GameTests.stored

    def test_legacy_specs_retain_exact_optional_absence_and_arcade_is_copied(self):
        old = games.default_spec()
        self.assertEqual(json.dumps(games.validate_spec(old)), json.dumps(old))
        self.assertNotIn('arcade', games.design_game('A space dodge game.')['spec'])
        arcade = {**deepcopy(old), 'genre': 'dodge', 'arcade': deepcopy(OPTIONS)}
        candidate = games.validate_spec(arcade)
        candidate['arcade']['rotation'] = False
        self.assertTrue(arcade['arcade']['rotation'])
        self.assertEqual(games.design_game('Title: Legacy space', arcade)['spec']['version'], 1)
        self.assertNotIn('levels', games.design_game('Title: Legacy space', arcade)['spec'])

    def test_all_boolean_combinations_follow_dependencies_in_both_schema_versions(self):
        for version in (1, 2):
            for bits in range(32):
                options = {name: bool(bits & 1 << index) for index, name in enumerate(OPTIONS)}
                value = {**games.default_spec(), 'genre': 'dodge', 'arcade': deepcopy(OPTIONS)}
                if version == 2: value = games.plan_levels(value, 3, 'stable')
                value['arcade'] = options
                if options['splitAsteroids'] and not options['shooting'] or options['highScores'] and not options['scoring']:
                    self.error(400, lambda: games.validate_spec(value))
                else: self.assertEqual(games.validate_spec(value), value)

    def test_arcade_structure_has_no_code_urls_nonbooleans_or_other_genres(self):
        value = {**games.default_spec(), 'genre': 'dodge', 'arcade': deepcopy(OPTIONS)}
        for arcade in [None, [], {}, True, {**OPTIONS, 'url': 'https://example.com'}]:
            self.error(400, lambda: games.validate_spec({**value, 'arcade': arcade}))
        for key in OPTIONS:
            missing = deepcopy(OPTIONS); missing.pop(key)
            self.error(400, lambda: games.validate_spec({**value, 'arcade': missing}))
            for invalid in [1, 0, 'true', 'false', None, [], {}]:
                self.error(400, lambda: games.validate_spec({**value, 'arcade': {**OPTIONS, key: invalid}}))
        for genre in ['collect', 'platformer']:
            self.error(400, lambda: games.validate_spec({**value, 'genre': genre}))

    def test_guided_creation_and_followups_match_playable_controls_and_collection_goal(self):
        state = self.create(prompt='Asteroids with 3 levels, collect 12, 90 seconds.')
        value = state['spec']
        self.assertEqual(value['arcade'], OPTIONS); self.assertEqual(value['genre'], 'dodge')
        self.assertEqual(value['theme'], 'space'); self.assertEqual(value['objects']['hazard'], 'asteroid')
        self.assertEqual(value['levels'][-1]['rules']['goal'], 12)
        for phrase in ['turn 360 degrees', 'Space fires', 'two pieces', 'snacks 10, large hits 20, small pieces 50']:
            self.assertIn(phrase, value['instructions'])
        shooting = games.design_game('Shooting off.', value)['spec']
        self.assertEqual(shooting['arcade'], {**OPTIONS, 'shooting': False, 'splitAsteroids': False})
        self.assertNotIn('Space fires', shooting['instructions'])
        self.assertTrue(all('Space fires' not in level['brief'] for level in shooting['levels']))
        points = games.design_game('Points off, leaderboard on.', value)['spec']
        self.assertFalse(points['arcade']['scoring']); self.assertFalse(points['arcade']['highScores'])
        restored = games.design_game('Splitting on and high scores on.', shooting)['spec']
        self.assertEqual(restored['arcade'], OPTIONS)
        self.assertNotIn('cannot add', games.design_game('Online leaderboard and shooting on.', value)['reply'])
        self.assertIn('cannot add', games.design_game('Add multiplayer and music.', value)['reply'])
        self.provider.converse.assert_not_called()

    def test_arcade_changes_invalidate_review_without_mutating_published_snapshot(self):
        published = self.publish(self.finish_test(self.create(prompt='Asteroids with two levels.')))
        candidate = deepcopy(published['spec'])
        candidate['arcade'].update(shooting=False, splitAsteroids=False)
        draft = games.update(self.api, self.claims, support.GAME, {'revision': published['revision'], 'spec': candidate})
        self.assertNotIn('testedRevision', draft)
        self.error(409, lambda: self.publish(draft))
        public = games.dispatch(self.api, {}, 'GET', '/games/published/' + support.GAME, {})
        self.assertEqual(public['spec']['arcade'], OPTIONS)
        copied = games.duplicate(self.api, self.claims, support.GAME, {'revision': draft['revision'], 'id': support.COPY})
        self.assertEqual(copied['spec']['arcade'], candidate['arcade']); self.assertEqual(copied['status'], 'Draft')
        self.assertNotIn('testedRevision', copied)

    def test_global_arcade_switches_preserve_authored_level_design_and_progression(self):
        original = games.design_game('Asteroids with three levels.')['spec']
        original['progression'] = 'Explore a moon, visit a garden, and return home.'
        original['levels'][1].update(title='My moon garden', theme='garden',
            brief='Look for the hidden flowers beside the moon gate.', seed=123456)
        original['levels'][1]['rules'].update(goal=19, timeLimit=120, lives=5, difficulty=4)
        for message in ['Rotation off.', 'Shooting off.', 'Splitting off.', 'Scoring off.', 'High scores off.', 'Level 2 shooting off.']:
            changed = games.design_game(message, original)['spec']
            self.assertEqual(changed['progression'], original['progression'])
            self.assertEqual(changed['rules'], original['rules'])
            self.assertEqual(changed['levels'][1], original['levels'][1])
            for before, after in zip(original['levels'], changed['levels']):
                self.assertEqual({key: value for key, value in after.items() if key != 'brief'},
                    {key: value for key, value in before.items() if key != 'brief'})
            if 'shooting' in message:
                self.assertTrue(all('Space fires' not in level['brief'] for level in changed['levels']))
        plain = deepcopy(original); plain.pop('arcade')
        enabled = games.design_game('Enable rotation.', plain)['spec']
        self.assertEqual(enabled['progression'], plain['progression']); self.assertEqual(enabled['levels'], plain['levels'])
        self.assertTrue(enabled['arcade']['rotation'])
        shuffled = games.design_game('Shooting off and shuffle layouts.', original)['spec']
        for key in ['title', 'rules', 'brief', 'theme']:
            self.assertEqual(shuffled['levels'][1][key], original['levels'][1][key])
        self.assertNotEqual(shuffled['levels'][1]['seed'], original['levels'][1]['seed'])
        brief_only = games.design_game('Rotation off.', original)['spec']
        old_hint = 'Use arrows or WASD to swim. Space fires. Large asteroids split into two pieces; one shot destroys each piece.'
        brief_only['levels'][0]['brief'] = old_hint
        self.assertTrue(games.design_game('Rotation on.', brief_only)['spec']['levels'][0]['brief'].startswith('Left/Right'))
        authored = 'a' * (300 - len(old_hint) - 1)
        brief_only['levels'][0]['brief'] = authored + ' ' + old_hint
        self.assertEqual(games.design_game('Rotation on.', brief_only)['spec']['levels'][0]['brief'], authored)

    def test_public_archive_accepts_score_row_cursors_without_exposing_board_content(self):
        published = self.publish(self.finish_test(self.create(prompt='Asteroids')))
        score_id = games.key('game-score', support.GAME)
        self.database.rows['published-games'][score_id] = {'id': score_id, 'organization_id': support.ORG,
            'service_id': support.SERVICE, 'payload': 'not even a game payload', 'secret': 'not returned'}
        for last_id in [score_id, 'game-score:' + support.OTHER + ':' + support.SERVICE + ':' + support.COPY]:
            cursor = base64.urlsafe_b64encode(json.dumps({'id': last_id}).encode()).decode()
            listing = games.list_games(self.api, None, {'queryStringParameters': {'cursor': cursor}}, True)
            self.assertEqual(listing['games'], [games.public_output(published)])
        for last_id in ['game-score:' + support.ORG + ':' + support.SERVICE + ':', score_id + ':extra',
                games.key('feedback', support.GAME), games.key('game-config')]:
            cursor = base64.urlsafe_b64encode(json.dumps({'id': last_id}).encode()).decode()
            self.error(400, lambda: games.list_games(self.api, None, {'queryStringParameters': {'cursor': cursor}}, True))
        cursor = base64.urlsafe_b64encode(json.dumps({'id': score_id}).encode()).decode()
        self.error(400, lambda: games.list_games(self.api, self.claims, {'queryStringParameters': {'cursor': cursor}}))

    def test_unpublish_and_delete_remove_the_board_in_the_same_transaction(self):
        state = self.publish(self.finish_test(self.create(prompt='Asteroids')))
        score_id = games.key('game-score', support.GAME)
        self.database.rows['published-games'][score_id] = {'id': score_id, 'payload': 'arcade names and receipts'}
        draft = games.publication(self.api, self.claims, support.GAME, {'revision': state['revision']}, False)
        self.assertNotIn(score_id, self.database.rows['published-games'])
        operations = self.database.meta.client.transact_write_items.call_args.kwargs['TransactItems']
        self.assertIn(score_id, [op['Delete']['Key']['id'] for op in operations if 'Delete' in op])
        self.assertNotIn(games.key('game', support.GAME), self.database.rows['published-games'])
        state = self.publish(self.finish_test(draft))
        self.database.rows['published-games'][score_id] = {'id': score_id, 'payload': 'arcade names and receipts'}
        games.delete(self.api, self.claims, support.GAME, {'revision': state['revision']})
        self.assertNotIn(score_id, self.database.rows['published-games'])
        operations = self.database.meta.client.transact_write_items.call_args.kwargs['TransactItems']
        self.assertIn(score_id, [op['Delete']['Key']['id'] for op in operations if 'Delete' in op])

    def test_failed_removal_transaction_preserves_game_and_board_together(self):
        state = self.publish(self.finish_test(self.create(prompt='Asteroids')))
        score_id = games.key('game-score', support.GAME)
        self.database.rows['published-games'][score_id] = {'id': score_id, 'payload': 'keep names'}
        before = deepcopy(self.database.rows)
        original = self.database.meta.client.transact_write_items.side_effect
        def stale(*args, **kwargs):
            row = self.database.rows['games'][games.key('game', support.GAME)]
            row['revision'] += 1
            return original(*args, **kwargs)
        with patch.object(self.database.meta.client, 'transact_write_items', side_effect=stale):
            self.error(409, lambda: games.publication(self.api, self.claims, support.GAME, {'revision': state['revision']}, False))
        self.assertEqual(self.database.rows['published-games'], before['published-games'])

    def test_model_contract_is_data_only_and_keeps_admin_budget_without_provider_calls(self):
        value = games.design_game('Asteroids with three levels.')['spec']
        self.provider.converse.return_value = {'stopReason': 'end_turn', 'output': {'message': {'content': [
            {'text': json.dumps({'text': 'Learn turning, practice collecting, and dodge more asteroids.', 'spec': value})}]}}}
        generated, _ = games.model_spec(self.af, {'instructions': 'Friendly arcade progression.'},
            {'target': 'admin-configured-target', 'maxOutputTokens': 1000}, {'spec': value, 'messages': []}, 'Make level 2 harder.')
        self.assertEqual(generated, value)
        call = self.provider.converse.call_args.kwargs
        self.assertEqual(call['inferenceConfig']['maxTokens'], 1000); self.assertNotIn('toolConfig', call)
        prompt = call['system'][0]['text']
        for phrase in ['five boolean fields', 'only for genre dodge', 'splitAsteroids requires shooting',
                'highScores requires scoring', 'two small pieces', 'remain the level win objective',
                'Preserve existing arcade options', 'never code']:
            self.assertIn(phrase, prompt)
        invalid = deepcopy(value); invalid['arcade']['shooting'] = False
        self.provider.converse.return_value['output']['message']['content'][0]['text'] = json.dumps({'text': 'Bad dependency.', 'spec': invalid})
        self.error(400, lambda: games.model_spec(self.af, {'instructions': ''}, {'target': 'fake', 'maxOutputTokens': 1000},
            {'spec': value, 'messages': []}, 'Turn shooting off.'))


if __name__ == '__main__': unittest.main()
