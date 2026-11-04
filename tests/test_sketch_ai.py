"""Public-geometry recognition and bounded illustrations; no hidden prompts."""
from copy import deepcopy
import importlib.util
from pathlib import Path
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('sketch_skills_test', ROOT / 'backend/nce_api/sketch_ai.py')
skills = importlib.util.module_from_spec(spec)
spec.loader.exec_module(skills)
engine_spec = importlib.util.spec_from_file_location('sketch_engine_test', ROOT / 'backend/nce_api/party_engine.py')
engine = importlib.util.module_from_spec(engine_spec)
engine_spec.loader.exec_module(engine)


class SketchAITests(unittest.TestCase):
    def test_every_bundled_prompt_has_legal_copy_isolated_art_for_the_fixed_canvas(self):
        self.assertEqual(set(skills.SUPPORTED_PROMPTS), {prompt for prompt, _ in engine.PROMPTS})
        for prompt in skills.SUPPORTED_PROMPTS:
            drawing = skills.drawing_for(prompt)
            self.assertTrue(drawing, prompt)
            self.assertLessEqual(len(drawing), 40)
            self.assertLessEqual(sum(len(stroke['points']) for stroke in drawing), 1600)
            for stroke in drawing:
                self.assertEqual(set(stroke), {'color', 'width', 'points'})
                self.assertTrue(1 <= len(stroke['points']) <= 120, prompt)
                self.assertTrue(all(len(point) == 2 and all(0 <= v <= 1 for v in point) for point in stroke['points']), prompt)
            drawing[0]['points'][0][0] = -20
            self.assertGreaterEqual(skills.drawing_for(prompt)[0]['points'][0][0], 0)
        self.assertEqual(skills.drawing_for('untrusted missing word'), [])

    def test_recognition_uses_drawing_structure_after_translation_scale_stroke_order_and_jitter(self):
        for prompt in ('snowman', 'robot', 'rainbow', 'cactus', 'sailboat', 'dinosaur', 'bicycle', 'umbrella'):
            drawing = skills.drawing_for(prompt)
            for index, stroke in enumerate(drawing):
                stroke['color'] = '#f07662'
                stroke['points'] = [[round(.1 + x * .7 + (.0005 if index % 2 else -.0005), 4), round(.1 + y * .7, 4)] for x, y in stroke['points']]
                stroke['points'].reverse()
            drawing.reverse()
            self.assertEqual(skills.rank_guesses(drawing)[0], prompt)

    def test_segmenting_a_continuous_line_does_not_change_the_guessed_object(self):
        source = skills.drawing_for('snowman')
        chunked = []
        for stroke in source:
            for offset in range(0, max(1, len(stroke['points']) - 1), 5):
                chunked.append({**stroke, 'points': stroke['points'][offset:offset + 6]})
        self.assertEqual(skills.rank_guesses(chunked)[0], 'snowman')
        self.assertEqual(skills.rank_guesses(source)[0], 'snowman')

    def test_empty_invalid_invisible_or_tiny_ink_does_not_invent_an_answer(self):
        cases = [
            None, [], [None],
            [{'color': None, 'points': [[0, 0]]}],
            [{'color': '#244b50', 'points': [[0, float('nan')]]}],
            [{'points': [[0, 0], [2, 1]]}],
            [{'points': [[0, 0], [10**1000, 1]]}],
            [{'points': [[0, 0], [0.001, 0.001], [0.002, 0.002]]}],
            [{'color': '#ffffff', 'points': [[0, 0], [1, 1], [0, 1]]}],
            [{'points': [[0, 0]]}],
        ]
        for drawing in cases:
            self.assertEqual(skills.rank_guesses(drawing), [])
        self.assertEqual(skills.rank_guesses([{'points': [[0, 0], [1, 1]]}] * 385), [])
        self.assertEqual(skills.rank_guesses([{'points': [[0, 0]] * 120}] * 67), [])

    def test_guesser_never_mutates_ink_and_does_not_accept_a_secret_answer_argument(self):
        ink = skills.drawing_for('rocket'); before = deepcopy(ink)
        self.assertEqual(skills.rank_guesses(ink)[0], 'rocket')
        self.assertEqual(ink, before)
        with self.assertRaises(TypeError):
            skills.rank_guesses(ink, 'snowman')

    def test_dense_valid_canvas_remains_bounded_for_repeated_bot_observations(self):
        ink = [{'color': '#244b50', 'points': [[(i % 97) / 97, (i % 89) / 89] for i in range(120)]} for _ in range(66)]
        started = time.monotonic()
        for _ in range(12):
            self.assertLessEqual(len(skills.rank_guesses(ink)), 3)
        self.assertLess(time.monotonic() - started, 5)


if __name__ == '__main__':
    unittest.main()
