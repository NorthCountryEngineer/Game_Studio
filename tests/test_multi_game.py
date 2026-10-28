"""Offline composition, review, snapshot and no-model tests for multi-game journeys."""
from copy import deepcopy
import unittest

import test_games as support
import test_game_scores as score_support

games, scores = support.games, score_support.scores


def journey():
    value = games.default_multi_game()
    value['steps'].insert(1, {'id': 'step-4', 'type': 'material', 'title': 'Client object', 'kind': 'interactive', 'reference': 'client:objects/one', 'required': True})
    value['steps'].append({'id': 'step-8', 'type': 'free-play', 'spec': games.design_game('Asteroids with endless survival.')['spec']})
    return value


class MultiGameTests(unittest.TestCase):
    setUp = support.GameTests.setUp
    authorize = support.GameTests.authorize
    event = support.GameTests.event
    error = support.GameTests.error
    create = support.GameTests.create
    publish = support.GameTests.publish
    message = support.GameTests.message
    configure_model = support.GameTests.configure_model
    save_config = support.GameTests.save_config
    write_registry = support.GameTests.write_registry

    def save(self, state, value):
        return games.update(self.api, self.claims, state['id'], {'revision': state['revision'], 'spec': value})

    def review(self, state):
        return games.complete_test(self.api, self.claims, state['id'], {'revision': state['revision'], 'reviewedLevelIds': [step['id'] for step in state['spec']['steps']]})

    def test_new_category_and_metadata_design_do_not_replace_games_with_mentioned_word_format(self):
        state = self.create(prompt='Create a multi-game with a crossword then word search.')
        self.assertEqual(state['spec'], games.default_multi_game())
        state = self.save(state, journey())
        self.configure_model()
        edited = self.message(state, 'Title: New journey\nMake the crossword harder.')
        self.assertEqual(edited['spec']['title'], 'New journey')
        self.assertEqual(edited['spec']['steps'], state['spec']['steps'])
        self.assertEqual(games.load(self.api, self.claims, state['id'])[0]['_modelCalls'], 0)
        self.provider.converse.assert_not_called()

    def test_every_outer_step_is_required_for_human_review_and_drafts_remain_private(self):
        state = self.save(self.create(), journey())
        for review in [['step-1', 'step-2'], ['step-1', 'step-2', 'step-4'], ['step-1', 'step-2', 'step-4', 'step-4']]:
            self.error(400, lambda: games.complete_test(self.api, self.claims, state['id'], {'revision': state['revision'], 'reviewedLevelIds': review}))
        published = self.publish(self.review(state))
        self.assertEqual(games.list_games(self.api, None, {}, True)['games'], [])
        catalog = games.list_games(self.api, None, {'queryStringParameters': {'specVersion': 'all'}}, True)
        self.assertEqual(catalog['games'][0]['spec'], journey())
        changed = journey(); changed['steps'][0]['spec']['title'] = 'Private child title'
        self.save(published, changed)
        public = games.dispatch(self.api, {}, 'GET', '/games/published/' + state['id'], {})
        self.assertEqual(public['spec'], journey())
        self.assertNotIn('messages', public)

    def test_nested_or_cooperative_games_and_midjourney_continuous_games_are_rejected(self):
        base = journey()
        cases = []
        nested = deepcopy(base); nested['steps'][0]['spec'] = deepcopy(base); cases.append(nested)
        cooperative = deepcopy(base); cooperative['steps'][0]['spec'] = games.design_game('Asteroids with multiplayer.')['spec']; cases.append(cooperative)
        endless = deepcopy(base); endless['steps'][0]['spec'] = endless['steps'][-1]['spec']; cases.append(endless)
        no_game = deepcopy(base); no_game['steps'] = [no_game['steps'][1]]; cases.append(no_game)
        not_final = deepcopy(base); not_final['steps'][0], not_final['steps'][-1] = not_final['steps'][-1], not_final['steps'][0]; cases.append(not_final)
        for value in cases: self.error(400, lambda: games.validate_spec(value))
        self.assertEqual(games.validate_spec(base), base)

    def test_journeys_cannot_read_or_create_casual_arcade_boards(self):
        published = self.publish(self.review(self.save(self.create(), journey())))
        with self.assertRaises(scores.ScoreError) as caught:
            scores.publication(self.api, published['id'], published['publishedRevision'])
        self.assertEqual(caught.exception.status, 404)
        self.assertNotIn(games.key('game-score', published['id']), self.database.rows['published-games'])

    def test_compositions_are_independent_deep_copies_with_bounded_combined_sprite_bytes(self):
        original = journey(); copied = games.validate_spec(original)
        copied['steps'][0]['spec']['title'] = 'Independent'
        self.assertNotEqual(copied, original)
        import base64
        arcade = games.design_game('Asteroids with 1 level and enemy ships.')['spec']
        sprite = {'width': 64, 'height': 64, 'pixels': base64.b64encode(bytes([255]) * 64 * 64 * 4).decode('ascii')}
        arcade['sprites'] = {role: sprite for role in ('player', 'asteroid', 'reward', 'enemy')}
        large = games.default_multi_game(); large['steps'] = [{'id': 'step-' + str(index + 1), 'type': 'game', 'spec': arcade} for index in range(3)]
        self.error(400, lambda: games.validate_spec(large))


if __name__ == '__main__': unittest.main()
