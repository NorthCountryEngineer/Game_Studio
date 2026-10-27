"""Synthetic v6 admission, human review, model controls, scores and relay bounds."""
from copy import deepcopy
import json
import math
import unittest
from unittest.mock import patch

import test_games as support
import test_game_scores as score_support
import test_multiplayer as relay_support

games, scores, relay = support.games, score_support.scores, relay_support.relay


def advanced(endless=True):
    return games.design_game('Asteroids with three levels, three asteroid sizes, medium enemy ships with 3 hit points.' + (' No time limit.' if endless else ''))['spec']


class AdvancedAdmissionTests(unittest.TestCase):
    def test_explicit_version_shape_and_nested_bounds(self):
        spec = advanced()
        self.assertEqual(spec['version'], 6)
        self.assertEqual(games.validate_spec(spec), spec)
        mutations = [lambda v: v['asteroids'].update(endless=1), lambda v: v['asteroids'].update(difficultyInterval=9),
            lambda v: v['asteroids'].update(sizes=True), lambda v: v['asteroids'].update(sizes=4),
            lambda v: v['asteroids'].update(extra=True), lambda v: v['asteroids']['enemies'].update(enabled=1),
            lambda v: v['asteroids']['enemies'].update(difficulty='expert'), lambda v: v['asteroids']['enemies'].update(hitPoints=11),
            lambda v: v['asteroids']['enemies'].update(spawnInterval=4), lambda v: v['asteroids']['enemies'].update(maxShips=7),
            lambda v: v.update(version=2), lambda v: v['arcade'].update(shooting=False, splitAsteroids=False)]
        for mutate in mutations:
            value = deepcopy(spec); mutate(value)
            with self.assertRaises(games.GameError): games.validate_spec(value)
        for version in (1, 2, 4, 5):
            value = games.design_game('Asteroids with prizes and multiplayer.')['spec'] if version == 5 else games.design_game('Asteroids.')['spec']
            if version == 1:
                value['version'] = 1; value.pop('levels'); value.pop('progression')
            elif version == 4:
                value.update(version=4, multiplayer={'mode': 'cooperative', 'maxPlayers': 2})
            original = deepcopy(value)
            self.assertEqual(games.validate_spec(value), original)
            self.assertNotIn('asteroids', value)

    def test_authored_levels_and_settings_survive_unrelated_edits_and_safe_downgrade(self):
        spec = advanced(); spec['levels'][1].update(title='Authored trail', brief='A carefully authored route.', seed=4242)
        for message in ('Title: New title', 'Add prizes.', 'Add cooperation.', 'No prizes.', 'No multiplayer.'):
            changed = games.design_game(message, spec)['spec']
            self.assertEqual(changed['version'], 6)
            self.assertEqual(changed['asteroids'], spec['asteroids'])
            self.assertEqual(changed['levels'], spec['levels'])
        finite = games.design_game('Restore timed levels.', spec)['spec']
        self.assertFalse(finite['asteroids']['endless']); self.assertEqual(finite['levels'], spec['levels'])
        downgraded = games.design_game('Disable shooting.', spec)['spec']
        self.assertEqual(downgraded['version'], 2); self.assertNotIn('asteroids', downgraded); self.assertNotIn('powerUps', downgraded)
        self.assertEqual(downgraded['levels'][1]['seed'], 4242)
        self.assertEqual(downgraded['levels'][1]['brief'], 'A carefully authored route.')


class AdvancedPublishingTests(unittest.TestCase):
    setUp = support.GameTests.setUp
    authorize = support.GameTests.authorize
    event = support.GameTests.event
    create = support.GameTests.create
    publish = support.GameTests.publish
    message = support.GameTests.message
    stored = support.GameTests.stored
    save_config = support.GameTests.save_config
    configure_model = support.GameTests.configure_model
    write_registry = support.GameTests.write_registry

    def test_endless_review_requires_exact_first_saved_level_but_finite_requires_all(self):
        state = self.create(prompt='Endless Asteroids with three levels.')
        original = deepcopy(state['spec']['levels'])
        for ids in (None, [], ['level-2'], ['level-1', 'level-2', 'level-3']):
            with self.assertRaises(games.GameError): games.complete_test(self.api, self.claims, support.GAME,
                {'revision': state['revision'], **({'reviewedLevelIds': ids} if ids is not None else {})})
        state = games.complete_test(self.api, self.claims, support.GAME, {'revision': state['revision'], 'reviewedLevelIds': ['level-1']})
        published = self.publish(state)
        self.assertEqual(published['spec']['levels'], original)
        self.assertEqual(games.list_games(self.api, None, {}, True)['games'], [])
        self.assertEqual(len(games.list_games(self.api, None, {'queryStringParameters': {'specVersion': 'all'}}, True)['games']), 1)
        spec = deepcopy(published['spec']); spec['asteroids']['endless'] = False
        state = games.update(self.api, self.claims, support.GAME, {'revision': published['revision'], 'spec': spec})
        with self.assertRaises(games.GameError): games.complete_test(self.api, self.claims, support.GAME, {'revision': state['revision'], 'reviewedLevelIds': ['level-1']})
        self.provider.converse.assert_not_called()

    def test_model_cannot_enable_advanced_or_change_existing_controls_and_preserves_optional_formats(self):
        self.configure_model(); state = self.create(prompt='Asteroids.')
        invented = games.design_game('Endless with hard enemy ships and three sizes.', state['spec'])['spec']
        self.provider.converse.return_value = {'output': {'message': {'content': [{'text': json.dumps({'text': 'Updated.', 'spec': invented})}]}}}
        with self.assertRaises(games.GameError) as error: self.message(state, 'Title: A new title')
        self.assertEqual(error.exception.status, 502)
        pending, _ = games.load(self.api, self.claims, support.GAME)
        intended = games.design_game('Add prizes and multiplayer.', invented)['spec']
        intended['asteroids']['enemies']['hitPoints'] = 7
        state = games.update(self.api, self.claims, support.GAME, {'revision': pending['revision'], 'spec': intended})
        proposed = deepcopy(state['spec']); proposed.update(version=2, title='New name')
        for field in ('asteroids', 'powerUps', 'multiplayer'): proposed.pop(field)
        self.provider.converse.return_value = {'output': {'message': {'content': [{'text': json.dumps({'text': 'Updated title.', 'spec': proposed})}]}}}
        changed = self.message(state, 'Title: New name', request=support.SECOND)
        for field in ('asteroids', 'powerUps', 'multiplayer'): self.assertEqual(changed['spec'][field], intended[field])
        self.assertEqual(changed['spec']['version'], 6)
        self.assertEqual(changed['spec']['levels'], intended['levels'])
        self.assertFalse(self.database.rows['published-games'])
        prompt = self.provider.converse.call_args.kwargs['system'][0]['text']
        for word in ('endless', 'easy ships wander', 'medium ships gently home', '100/200/300'): self.assertIn(word, prompt)

    def test_explicit_advanced_request_is_authoritative_even_when_model_returns_old_format(self):
        self.configure_model(); state = self.create(prompt='Asteroids.')
        self.provider.converse.return_value = {'output': {'message': {'content': [{'text': json.dumps({'text': 'Updated.', 'spec': state['spec']})}]}}}
        updated = self.message(state, 'No time limit. Three asteroid sizes. Add easy enemy ships with 2 hit points.')
        self.assertEqual(updated['spec']['version'], 6)
        self.assertEqual(updated['spec']['asteroids']['enemies']['hitPoints'], 2)
        self.assertTrue(updated['spec']['asteroids']['endless'])


class AdvancedScoreTests(unittest.TestCase):
    def report(self, **changes):
        return dict(outcome='lost', elapsed=300, score=50, points=25000, reviewedLevelIds=['level-1'], **changes)

    def test_endless_reports_are_lost_only_first_level_and_bounded_by_elapsed(self):
        spec = advanced(); report = self.report()
        with patch.object(scores, '_games', games):
            self.assertEqual(scores.validate_result(report, spec), report)
            invalid = [dict(report, outcome='won'), dict(report, reviewedLevelIds=['level-1', 'level-2']), dict(report, reviewedLevelIds=['level-2']),
                dict(report, elapsed=math.inf), dict(report, elapsed=2147483648), dict(report, elapsed=True),
                dict(report, points=602001), dict(report, score=6041), dict(report, score=True), dict(report, points=2147483648)]
            for value in invalid:
                with self.assertRaises(scores.ScoreError): scores.validate_result(value, spec)
            maximal = dict(report, elapsed=2147483647, score=2147483647, points=2147483647)
            self.assertEqual(scores.validate_result(maximal, spec), maximal)
            self.assertEqual(scores.max_points(spec, games.get_levels(spec), 10), 22000)
            cooperative = dict(spec, multiplayer={'mode': 'cooperative', 'maxPlayers': 2})
            with self.assertRaises(scores.ScoreError): scores.validate_result(report, cooperative)

    def test_finite_v6_keeps_authored_completion_and_timer_requirements(self):
        spec = advanced(False); levels = spec['levels']; maximum = sum(level['rules']['goal'] for level in levels)
        report = dict(outcome='won', elapsed=10, score=maximum, points=22000, reviewedLevelIds=[level['id'] for level in levels])
        with patch.object(scores, '_games', games):
            self.assertEqual(scores.validate_result(report, spec), report)
            for change in [dict(elapsed=1000), dict(points=22001), dict(score=maximum + 1), dict(reviewedLevelIds=['level-1'])]:
                with self.assertRaises(scores.ScoreError): scores.validate_result(dict(report, **change), spec)


class AdvancedRelayTests(unittest.TestCase):
    setUp = relay_support.MultiplayerTests.setUp
    snapshot = relay_support.MultiplayerTests.snapshot

    def advanced_snapshot(self):
        self.spec = dict(advanced(), multiplayer={'mode': 'cooperative', 'maxPlayers': 2})
        self.spec['asteroids']['enemies']['difficulty'] = 'hard'
        value = self.snapshot(); value.update(elapsed=300, nextId=100, advanced={'difficulty': 11, 'nextEnemy': 15,
            'enemies': [dict(id=90, x=100, y=100, w=38, h=28, vx=80, vy=0, hp=2, maxHp=3, fireCooldown=1, phase=0)],
            'enemyBullets': [dict(id=91, x=100, y=120, vx=100, vy=100, ttl=3)]})
        value['players'][0].update(score=50, points=25000)
        value['entities'] = [dict(id=92, kind='hazard', x=100, y=50, w=30, h=30, vx=10, vy=10, asteroid='medium')]
        return value

    def test_new_snapshot_shape_is_finite_bounded_and_version_specific(self):
        original = self.advanced_snapshot()
        self.assertEqual(relay.validate_state(original, self.spec), original)
        mutations = [lambda v: v.pop('advanced'), lambda v: v['advanced'].update(extra=1),
            lambda v: v.update(outcome='won'), lambda v: v.update(levelIndex=1), lambda v: v.update(elapsed=2147483648),
            lambda v: v['advanced'].update(difficulty=True), lambda v: v['advanced'].update(nextEnemy=61),
            lambda v: v['advanced']['enemies'][0].update(hp=4), lambda v: v['advanced']['enemies'][0].update(maxHp=2),
            lambda v: v['advanced']['enemies'][0].update(phase=math.inf), lambda v: v['advanced']['enemies'][0].update(w=39),
            lambda v: v['advanced']['enemyBullets'][0].update(owner=0), lambda v: v['advanced']['enemyBullets'][0].update(id=90),
            lambda v: v['advanced']['enemyBullets'][0].update(ttl=4.01), lambda v: v['advanced']['enemyBullets'][0].update(vx=801),
            lambda v: v['entities'][0].update(w=42), lambda v: v['players'][0].update(score=6041),
            lambda v: v['players'][0].update(points=602001)]
        for mutate in mutations:
            value = deepcopy(original); mutate(value)
            with self.assertRaises(relay.MultiplayerError): relay.validate_state(value, self.spec)
        legacy = dict(self.spec, version=4); legacy.pop('asteroids')
        with self.assertRaises(relay.MultiplayerError): relay.validate_state(original, legacy)
        disabled = deepcopy(self.spec); disabled['asteroids']['enemies']['enabled'] = False
        with self.assertRaises(relay.MultiplayerError): relay.validate_state(original, disabled)
        for difficulty in ('easy', 'medium'):
            passive = deepcopy(self.spec); passive['asteroids']['enemies']['difficulty'] = difficulty
            with self.assertRaises(relay.MultiplayerError): relay.validate_state(original, passive)
            valid = deepcopy(original); valid['advanced']['enemyBullets'] = []
            self.assertEqual(relay.validate_state(valid, passive), valid)
        two = deepcopy(self.spec); two['asteroids']['sizes'] = 2
        with self.assertRaises(relay.MultiplayerError): relay.validate_state(original, two)

    def test_finite_advanced_difficulty_stays_authored_when_elapsed_changes(self):
        value = self.advanced_snapshot()
        self.spec['asteroids']['endless'] = False
        value['levelIndex'] = 1
        rules = self.spec['levels'][1]['rules']
        value['advanced']['difficulty'] = rules['difficulty']
        for player in value['players']: player.update(score=0, points=100)
        for elapsed in (1, rules['timeLimit']):
            value['elapsed'] = elapsed
            self.assertEqual(relay.validate_state(value, self.spec), value)
            wrong = deepcopy(value)
            wrong['advanced']['difficulty'] = rules['difficulty'] + 1
            with self.assertRaises(relay.MultiplayerError): relay.validate_state(wrong, self.spec)
        # Enabling advanced mechanics does not admit an elapsed-derived ramp in finite mode.
        value['elapsed'] = rules['timeLimit']
        value['advanced']['difficulty'] = math.floor(value['elapsed'] / self.spec['asteroids']['difficultyInterval']) + 1
        self.assertNotEqual(value['advanced']['difficulty'], rules['difficulty'])
        with self.assertRaises(relay.MultiplayerError): relay.validate_state(value, self.spec)

    def test_weighted_three_stage_budget_and_cross_collection_id_caps(self):
        value = self.advanced_snapshot(); value['nextId'] = 2147483647
        value['entities'] = [dict(id=index+1, kind='hazard', x=0, y=0, w=42, h=42, vx=0, vy=0, asteroid='large') for index in range(16)]
        self.assertEqual(relay.validate_state(value, self.spec), value)
        value['entities'].append(dict(value['entities'][0], id=17))
        with self.assertRaises(relay.MultiplayerError): relay.validate_state(value, self.spec)
        value = self.advanced_snapshot(); value['nextId'] = 2147483647
        value['advanced']['enemyBullets'][0]['id'] = 2147483646
        self.assertEqual(relay.validate_state(value, self.spec), value)
        value['advanced']['enemyBullets'][0]['id'] = 2147483647
        with self.assertRaises(relay.MultiplayerError): relay.validate_state(value, self.spec)
