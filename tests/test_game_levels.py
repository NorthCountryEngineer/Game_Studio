"""Offline level plans, review gates, and model-output boundaries."""
from copy import deepcopy
import json
import unittest
import test_games as support

GAME, games = support.GAME, support.games


def level_spec():
    spec = games.default_spec()
    spec.update(version=2, progression='Learn to swim, practice dodging, then combine both skills.', levels=[])
    for index, difficulty in enumerate([1, 2, 3]):
        spec['levels'].append({'id': f'level-{index + 1}', 'title': ['First swim', 'Rocky passage', 'Pond finale'][index],
            'brief': f'Collect {3 + index * 2} water snacks while avoiding rocks.', 'theme': 'pond',
            'rules': {'goal': 3 + index * 2, 'timeLimit': 60, 'lives': 3, 'difficulty': difficulty}, 'seed': 17031 + index})
    return spec


class GameLevelTests(unittest.TestCase):
    setUp = support.GameTests.setUp
    authorize = support.GameTests.authorize
    event = support.GameTests.event
    error = support.GameTests.error
    create = support.GameTests.create
    stored = support.GameTests.stored
    publish = support.GameTests.publish

    def save_levels(self):
        state = self.create()
        return games.update(self.api, self.claims, GAME, {'revision': state['revision'], 'spec': level_spec()})

    def review(self, state, ids=None):
        return games.complete_test(self.api, self.claims, GAME,
            {'revision': state['revision'], 'reviewedLevelIds': ids if ids is not None else ['level-1', 'level-2', 'level-3']})

    def model(self, candidate=None, stop_reason='end_turn'):
        spec = level_spec() if candidate is None else candidate
        self.provider.converse.return_value = {'stopReason': stop_reason,
            'output': {'message': {'content': [{'text': json.dumps({'text': 'Learn, practice, then take on the finale.', 'spec': spec})}]}}}
        return games.model_spec(self.af, {'instructions': 'Keep the progression friendly.'},
            {'target': 'admin-selected-model', 'maxOutputTokens': 1024}, {'spec': level_spec(), 'messages': []},
            'Plan three gentle levels with a rocky finale.')

    def test_version_one_remains_strict_and_supported(self):
        original = games.default_spec()
        self.assertEqual(games.validate_spec(original), original)
        candidate = deepcopy(original); candidate['levels'] = level_spec()['levels']
        self.error(400, lambda: games.validate_spec(candidate))
        for version in [True, 0, 3, 2.0, '2', None]:
            candidate = level_spec(); candidate['version'] = version
            self.error(400, lambda: games.validate_spec(candidate))

    def test_new_free_plan_has_three_reviewable_levels_without_provider_calls(self):
        state = self.create(prompt='a gentle pond game, collect 10 snacks, 60 seconds')
        spec = state['spec']
        self.assertEqual(spec['version'], 2); self.assertEqual(len(spec['levels']), 3)
        self.assertEqual([level['rules']['goal'] for level in spec['levels']], [6, 8, 10])
        self.assertEqual([level['rules']['difficulty'] for level in spec['levels']], [1, 1, 2])
        self.assertEqual(len({level['seed'] for level in spec['levels']}), 3)
        self.assertIn('fixed progression rules', state['messages'][-1]['text'])
        self.assertIn('Each level starts with fresh lives and time.', spec['progression'])
        self.provider.converse.assert_not_called()

    def test_level_count_and_progression_follow_supported_creator_requests(self):
        for request, expected in [('one level', 1), ('eight levels', 8), ('5 levels', 5), ('levels: 4', 4),
                ('4 gentle levels', 4), ('five increasingly tricky levels', 5)]:
            result = games.design_game('a space platformer, ' + request + ', collect 12, difficulty 3')
            spec = result['spec']; self.assertEqual(len(spec['levels']), expected)
            self.assertEqual([level['id'] for level in spec['levels']], [f'level-{index + 1}' for index in range(expected)])
            self.assertTrue(all(level['theme'] == 'space' for level in spec['levels']))
            goals = [level['rules']['goal'] for level in spec['levels']]
            difficulties = [level['rules']['difficulty'] for level in spec['levels']]
            self.assertEqual(goals, sorted(goals)); self.assertEqual(difficulties, sorted(difficulties))
            self.assertEqual(goals[-1], 12)
        before = games.design_game('a pond game with 4 levels')['spec']
        after = games.design_game('99 levels', before)
        self.assertEqual(len(after['spec']['levels']), 4)
        self.assertIn('1 to 8 levels', after['reply'])

    def test_layouts_are_stable_on_retries_and_small_edits_then_explicitly_shuffled(self):
        first = games.design_game('a pond game with 3 levels, collect 8')['spec']
        self.assertEqual(first, games.design_game('a pond game with 3 levels, collect 8')['spec'])
        renamed = games.design_game('Title: Moon Swim', first)['spec']
        self.assertEqual(renamed['levels'], first['levels'])
        noop = games.design_game('thanks', renamed)['spec']
        self.assertEqual(noop, renamed)
        shuffled = games.design_game('shuffle layouts', renamed)['spec']
        self.assertNotEqual([level['seed'] for level in shuffled['levels']], [level['seed'] for level in first['levels']])
        for old, new in zip(renamed['levels'], shuffled['levels']):
            self.assertEqual({name: value for name, value in old.items() if name != 'seed'},
                {name: value for name, value in new.items() if name != 'seed'})
        self.assertEqual(shuffled, games.design_game('shuffle layouts', renamed)['spec'])

    def test_targeted_level_changes_do_not_replan_other_levels_or_base_rules(self):
        before = games.design_game('a pond game with 3 levels, collect 10, difficulty 2')['spec']
        changed = games.design_game('level 2 harder, collect 12, 90 seconds', before)['spec']
        self.assertEqual(changed['rules'], before['rules'])
        self.assertEqual(changed['levels'][0], before['levels'][0])
        self.assertEqual(changed['levels'][2], before['levels'][2])
        self.assertEqual(changed['levels'][1]['rules']['difficulty'], 4)
        self.assertEqual(changed['levels'][1]['rules']['goal'], 12)
        self.assertEqual(changed['levels'][1]['rules']['timeLimit'], 90)
        self.assertEqual(changed['levels'][1]['seed'], before['levels'][1]['seed'])
        self.assertIn('Collect 12', changed['levels'][1]['brief'])
        shuffled = games.design_game('level 2 shuffle layouts', changed)['spec']
        self.assertNotEqual(shuffled['levels'][1]['seed'], changed['levels'][1]['seed'])
        self.assertEqual(shuffled['levels'][0], changed['levels'][0])
        self.assertEqual(shuffled['levels'][2], changed['levels'][2])

    def test_targeted_aliases_and_shuffle_apply_to_actual_level_without_silent_replan(self):
        before = games.design_game('a pond game with 3 levels, collect 10, difficulty 2')['spec']
        changed = games.design_game('level 1 10 snacks', before)['spec']
        self.assertEqual(changed['levels'][0]['rules']['goal'], 10)
        self.assertEqual(changed['rules'], before['rules'])
        self.assertEqual(changed['levels'][1:], before['levels'][1:])
        changed['levels'][1]['rules'].update(timeLimit=90, lives=1)
        restored = games.design_game('level 2 time 60, lives: 3', changed)['spec']
        self.assertEqual(restored['levels'][1]['rules']['timeLimit'], 60)
        self.assertEqual(restored['levels'][1]['rules']['lives'], 3)
        shuffled = games.design_game('Randomize level 2', restored)['spec']
        self.assertNotEqual(shuffled['levels'][1]['seed'], restored['levels'][1]['seed'])
        self.assertEqual(shuffled['levels'][0], restored['levels'][0])
        self.assertEqual(shuffled['levels'][2], restored['levels'][2])
        self.assertEqual(shuffled['levels'][1]['brief'], restored['levels'][1]['brief'])

    def test_legacy_edits_retain_original_single_level_until_creator_requests_levels(self):
        before = games.default_spec()
        renamed = games.design_game('Title: Legacy pond', before)['spec']
        self.assertEqual(renamed['version'], 1); self.assertNotIn('levels', renamed)
        self.assertEqual(games.get_levels(renamed)[0]['seed'], 17031)
        upgraded = games.design_game('add levels', renamed)['spec']
        self.assertEqual(upgraded['version'], 2); self.assertEqual(len(upgraded['levels']), 3)

    def test_level_plan_has_bounded_exact_fields_and_is_copied(self):
        original = level_spec(); validated = games.validate_spec(original)
        self.assertEqual(validated, original)
        validated['levels'][0]['rules']['goal'] = 40
        self.assertEqual(original['levels'][0]['rules']['goal'], 3)
        for key in ['progression', 'levels']:
            candidate = level_spec(); candidate.pop(key)
            self.error(400, lambda: games.validate_spec(candidate))
        for levels in [[], {}, None, [level_spec()['levels'][0]] * 9]:
            candidate = level_spec(); candidate['levels'] = levels
            self.error(400, lambda: games.validate_spec(candidate))
        candidate = level_spec(); candidate['levels'][1]['id'] = 'level-1'
        self.error(400, lambda: games.validate_spec(candidate))
        for identifier in ['level-0', 'level-9', 'foo', 1, ['level-1']]:
            candidate = level_spec(); candidate['levels'][0]['id'] = identifier
            self.error(400, lambda: games.validate_spec(candidate))
        for name in ['script', 'assetUrl', 'difficultyCurve', 'publish']:
            candidate = level_spec(); candidate['levels'][0][name] = 'untrusted'
            self.error(400, lambda: games.validate_spec(candidate))

    def test_level_numbers_and_plain_text_share_strict_game_boundaries(self):
        for seed in [True, False, 0, -1, 2147483648, 1.0, '5', None]:
            candidate = level_spec(); candidate['levels'][0]['seed'] = seed
            self.error(400, lambda: games.validate_spec(candidate))
        for path, value in [('goal', 2), ('goal', 41), ('timeLimit', 29), ('timeLimit', 181),
                ('lives', 0), ('lives', 6), ('difficulty', True), ('difficulty', 6)]:
            candidate = level_spec(); candidate['levels'][0]['rules'][path] = value
            self.error(400, lambda: games.validate_spec(candidate))
        for value in ['', ' leading', 'trailing ', 'https://example.com', '<script>', 'eval(', 'a\nline', '🐟' * 151]:
            candidate = level_spec(); candidate['levels'][0]['brief'] = value
            self.error(400, lambda: games.validate_spec(candidate))
            candidate = level_spec(); candidate['progression'] = value
            self.error(400, lambda: games.validate_spec(candidate))
        candidate = level_spec(); candidate['levels'][0]['theme'] = 'external-world'
        self.error(400, lambda: games.validate_spec(candidate))

    def test_every_level_requires_explicit_review_for_the_exact_revision(self):
        state = self.save_levels()
        self.error(400, lambda: games.complete_test(self.api, self.claims, GAME, {'revision': state['revision']}))
        for ids in [[], ['level-1'], ['level-1', 'level-2', 'level-2'], ['level-1', 'level-2', 'level-4'],
                ['level-1', 'level-2', 'level-3', 'level-4'], ['level-1', 'level-2', {}], None, 'level-1']:
            self.error(400, lambda: games.complete_test(self.api, self.claims, GAME,
                {'revision': state['revision'], 'reviewedLevelIds': ids}))
        self.error(409, lambda: self.publish(state))
        tested = self.review(state, ['level-3', 'level-1', 'level-2'])
        self.assertEqual(tested['testedRevision'], tested['revision'])
        self.error(409, lambda: self.review(state))
        published = self.publish(tested)
        self.assertEqual(published['spec'], state['spec'])
        self.assertNotIn('reviewedLevelIds', published)

    def test_level_edits_invalidate_review_and_keep_public_snapshot_private(self):
        published = self.publish(self.review(self.save_levels()))
        candidate = deepcopy(published['spec']); candidate['levels'][1]['seed'] += 1
        draft = games.update(self.api, self.claims, GAME, {'revision': published['revision'], 'spec': candidate})
        self.assertNotIn('testedRevision', draft)
        self.error(409, lambda: self.publish(draft))
        public = games.dispatch(self.api, {}, 'GET', '/games/published/' + GAME, {})
        self.assertEqual(public['spec']['levels'][1]['seed'], published['spec']['levels'][1]['seed'])
        self.assertNotIn('messages', public); self.assertNotIn('testedRevision', public)

    def test_legacy_single_level_review_body_is_backward_compatible(self):
        state = self.create()
        state = games.update(self.api, self.claims, GAME, {'revision': state['revision'], 'spec': games.default_spec()})
        tested = games.complete_test(self.api, self.claims, GAME, {'revision': state['revision']})
        self.assertEqual(tested['testedRevision'], tested['revision'])
        tested = games.complete_test(self.api, self.claims, GAME,
            {'revision': tested['revision'], 'reviewedLevelIds': ['level-1']})
        self.assertEqual(tested['testedRevision'], tested['revision'])

    def test_rejected_level_count_preserves_authored_plan(self):
        candidate = games.design_game('A space game.')['spec']
        candidate['levels'][0]['title'] = 'My own opening'
        candidate['levels'][1]['rules']['goal'] = 17
        result = games.design_game('99 levels', candidate)
        self.assertEqual(result['spec'], candidate)
        self.assertIn('1 to 8 levels', result['reply'])

    def test_configured_assistant_receives_level_planning_contract_and_admin_token_cap(self):
        generated, reply = self.model()
        self.assertEqual(generated, level_spec()); self.assertIn('finale', reply)
        call = self.provider.converse.call_args.kwargs
        self.assertEqual(call['modelId'], 'admin-selected-model')
        self.assertEqual(call['inferenceConfig']['maxTokens'], 1024)
        self.assertNotIn('toolConfig', call)
        system = call['system'][0]['text']
        for requirement in ['level progression', '1..8 levels', 'Preserve existing level IDs', 'randomization', 'No extra fields', 'No code']:
            self.assertIn(requirement, system)
        request = json.loads(call['messages'][0]['content'][0]['text'])
        self.assertEqual(request['currentGame'], level_spec())
        self.assertIn('three gentle levels', request['request'])

    def test_model_cannot_downgrade_or_smuggle_level_behavior(self):
        self.error(502, lambda: self.model(games.default_spec()))
        for field, value in [('script', 'fetch(secret)'), ('assetUrl', 'https://example.com')]:
            candidate = level_spec(); candidate['levels'][0][field] = value
            self.error(400, lambda: self.model(candidate))
        candidate = level_spec(); candidate['levels'][0]['brief'] = '<script>alert(1)</script>'
        self.error(400, lambda: self.model(candidate))
        candidate = level_spec(); candidate['levels'][1]['rules']['difficulty'] = 6
        self.error(400, lambda: self.model(candidate))
        self.assertFalse(self.database.rows['published-games'])

    def test_truncated_filtered_or_tool_output_never_becomes_a_level_plan(self):
        for stop_reason in ['max_tokens', 'tool_use', 'content_filtered', 'guardrail_intervened', 'stop_sequence']:
            self.error(502, lambda: self.model(stop_reason=stop_reason))
        self.assertFalse(self.database.rows['published-games'])


if __name__ == '__main__': unittest.main()
