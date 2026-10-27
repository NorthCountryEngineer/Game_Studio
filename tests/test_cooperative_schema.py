"""Offline version-four compatibility tests; no provider or cloud calls."""
from copy import deepcopy
import unittest
from test_games import games


class CooperativeSchemaTests(unittest.TestCase):
    def spec(self):
        value = games.plan_levels(games.default_spec(), 2, 'synthetic twins')
        value.update(version=4, multiplayer={'mode': 'cooperative', 'maxPlayers': 2})
        return value

    def test_strict_version_four_and_legacy_opt_in(self):
        value = self.spec()
        self.assertEqual(games.validate_spec(value), value)
        self.assertEqual(games.default_spec()['version'], 1)
        for multiplayer in ({'mode': 'competitive', 'maxPlayers': 2}, {'mode': 'cooperative', 'maxPlayers': True}, {'mode': 'cooperative', 'maxPlayers': 3}, {'mode': 'cooperative', 'maxPlayers': 2, 'chat': True}):
            with self.subTest(multiplayer=multiplayer), self.assertRaises(games.GameError):
                games.validate_spec({**value, 'multiplayer': multiplayer})
        for edit in ({'version': 2}, {'levels': []}):
            with self.assertRaises(games.GameError): games.validate_spec({**value, **edit})
        value.pop('multiplayer')
        with self.assertRaises(games.GameError): games.validate_spec(value)

    def test_saved_levels_and_cooperation_survive_refinement(self):
        value = self.spec()
        for message in ('Title: Twins', 'Level 2 harder', 'Collect 7', '4 levels'):
            updated = games.design_game(message, deepcopy(value))['spec']
            self.assertEqual(updated['version'], 4)
            self.assertEqual(updated['multiplayer'], value['multiplayer'])
            self.assertEqual([level['seed'] for level in updated['levels'][:2]], [level['seed'] for level in value['levels']])
        disabled = games.design_game('disable multiplayer', value)['spec']
        self.assertEqual(disabled['version'], 2)
        self.assertNotIn('multiplayer', disabled)
        self.assertEqual(games.design_game('add two-player cooperation', games.default_spec())['spec']['version'], 4)


if __name__ == '__main__': unittest.main()
