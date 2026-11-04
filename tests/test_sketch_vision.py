"""Synthetic raster/architecture/integrity checks, not a human accuracy claim."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('test_sketch_vision', ROOT / 'backend/nce_api/sketch_vision.py')
vision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vision)


def stroke(points, color='#244b50', width=5):
    return {'color': color, 'width': width, 'points': points}


class SketchVisionTests(unittest.TestCase):
    def test_fixed_convolution_matches_scalar_hwio_cross_correlation(self):
        image = np.arange(20, dtype=np.float32).reshape(4, 5, 1) / 20
        kernel = np.arange(18, dtype=np.float32).reshape(3, 3, 1, 2) / 18 - .5
        bias = np.array([.1, -.1], dtype=np.float32)
        padded = np.pad(image, ((1, 1), (1, 1), (0, 0)))
        expected = np.zeros((4, 5, 2), dtype=np.float32)
        for row in range(4):
            for col in range(5):
                for out in range(2):
                    expected[row, col, out] = max(0, (padded[row:row + 3, col:col + 3] * kernel[:, :, :, out]).sum() + bias[out])
        np.testing.assert_allclose(vision._conv(image, kernel, bias), expected, atol=2e-7)

    def test_manifest_hashes_cover_all_bundled_pretrained_bytes(self):
        manifest = json.loads((vision._ASSETS / 'manifest.json').read_text())
        for item in manifest['files']:
            data = (vision._ASSETS / item['path']).read_bytes()
            self.assertEqual(len(data), item['bytes'])
            self.assertEqual(hashlib.sha256(data).hexdigest(), item['sha256'])
        weights, labels = vision._model()
        self.assertEqual(sum(weight.size for weight in weights), 544201)
        self.assertEqual(len(labels), 345)

    def test_corrupt_asset_abstains_instead_of_loading_weights(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'weights.bin').write_bytes(b'bad')
            (root / 'classes.txt').write_bytes(b'bad')
            vision._model.cache_clear()
            try:
                with patch.object(vision, '_ASSETS', root), self.assertRaises(vision.RecognitionUnavailable):
                    vision._model()
            finally:
                vision._model.cache_clear()

    def test_blank_erased_and_tiny_canvas_abstains(self):
        black = stroke([[.2, .5], [.8, .5]], width=3)
        erase = stroke([[.2, .5], [.8, .5]], '#ffffff', 12)
        self.assertEqual(vision.predict([]), [])
        self.assertEqual(vision.predict([black, erase]), [])
        self.assertEqual(vision.predict([stroke([[.5, .5]], width=3)]), [])

    def test_eraser_is_chronological_and_later_ink_reappears(self):
        line = stroke([[.2, .5], [.8, .5]], width=3)
        erase = stroke([[.2, .5], [.8, .5]], '#ffffff', 12)
        np.testing.assert_array_equal(vision.render_bitmap([erase, line]), vision.render_bitmap([line]))
        np.testing.assert_array_equal(vision.render_bitmap([line, erase, line]), vision.render_bitmap([line]))

    def test_all_visible_brush_colors_have_identical_geometry(self):
        points = [[.2, .2], [.5, .7], [.8, .2]]
        reference = vision.render_bitmap([stroke(points)])
        for color in ['#f07662', '#4f8f73', '#6b5a9d', '#e4b347']:
            np.testing.assert_array_equal(vision.render_bitmap([stroke(points, color)]), reference)

    def test_width_is_composited_before_pen_normalization(self):
        line = [[.2, .5], [.8, .5]]
        fine = vision.render_bitmap([stroke(line, width=3), stroke(line, '#ffffff', 5)])
        bold = vision.render_bitmap([stroke(line, width=10), stroke(line, '#ffffff', 5)])
        self.assertEqual(int(fine.sum()), 0)
        self.assertGreater(int(bold.sum()), 0)

    def test_physical_aspect_is_preserved_for_rectangles(self):
        # 400 by 100 physical pixels on the actual 800 by 500 board.
        bitmap = vision.render_bitmap([stroke([[.25, .4], [.75, .4], [.75, .6], [.25, .6], [.25, .4]])])
        rows, cols = np.nonzero(bitmap > 80)
        self.assertGreater((cols.max() - cols.min()) / (rows.max() - rows.min()), 2.5)

    def test_scores_are_global_finite_sorted_and_bounded(self):
        bitmap = np.zeros((28, 28), dtype=np.uint8)
        bitmap[6:22, 6:8] = 255
        bitmap[20:22, 6:22] = 255
        result = vision.predict_bitmap(bitmap)
        self.assertEqual(len(result), 5)
        self.assertEqual(result, sorted(result, key=lambda item: -item['score']))
        self.assertLessEqual(sum(item['score'] for item in result), 1.000001)
        self.assertTrue(all(0 <= item['score'] <= 1 for item in result))
        self.assertEqual(len({item['label'] for item in result}), 5)

    def test_invalid_shapes_values_and_work_bounds_rejected(self):
        bad = [stroke([[float('nan'), .1]]), stroke([[1.1, .2]]), stroke([[True, .2]]),
               stroke([[.1, .2]], width=float('inf')), stroke([[.1, .2]], color='#xyzxyz'),
               stroke([[.1, .2]] * 121)]
        for value in bad:
            with self.subTest(value=value), self.assertRaises(ValueError): vision.predict([value])
        with self.assertRaises(ValueError): vision.predict([stroke([[.1, .2]])] * 385)
        with self.assertRaises(ValueError): vision.predict([stroke([[.1, .2]] * 120)] * 67)
        with self.assertRaises(ValueError): vision.predict_bitmap(np.zeros((28, 28), dtype=np.float32))


if __name__ == '__main__':
    unittest.main()
