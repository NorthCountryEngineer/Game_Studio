"""Bounded, data-only DoodleNet inference over the public drawing canvas.

Imported only by the separate recognition route. No network, room/answer input,
TensorFlow graph deserialization, training, or fall back to artist templates.
"""
from functools import lru_cache
import hashlib
import math
import os
from pathlib import Path

MODEL_VERSION = 'doodlenet-0612a3e7-visible-v1'
_ASSETS = Path(__file__).with_name('models') / 'doodlenet'
_WEIGHTS_SHA256 = '91111f7bb89a7c41983e75d53f33c26b997d77d08a5c2801cbf51f07c443df83'
_CLASSES_SHA256 = '1bd82a29940199b411bf0ea54f3a1ee894c9f97bcffc674a369f037a770cbf5c'
_SHAPES = ((3, 3, 1, 16), (16,), (3, 3, 16, 16), (16,),
           (3, 3, 16, 32), (32,), (3, 3, 32, 32), (32,),
           (3, 3, 32, 64), (64,), (3, 3, 64, 64), (64,),
           (576, 512), (512,), (512, 345), (345,))


class RecognitionUnavailable(RuntimeError):
    """Missing/corrupt assets or optional native runtime; callers must abstain."""


@lru_cache(maxsize=1)
def _runtime():
    try:
        # A small convolution workload on a fractional Lambda CPU needs one
        # BLAS worker, not a machine-sized pool. Explicit operator settings win.
        os.environ.setdefault('OPENBLAS_NUM_THREADS', '1')
        import numpy as np
        from PIL import Image, ImageDraw
    except ImportError as exc:
        raise RecognitionUnavailable('Sketch recognition runtime unavailable') from exc
    return np, Image, ImageDraw


@lru_cache(maxsize=1)
def _model():
    np, _, _ = _runtime()
    try:
        raw = (_ASSETS / 'weights.bin').read_bytes()
        names = (_ASSETS / 'classes.txt').read_bytes()
    except OSError as exc:
        raise RecognitionUnavailable('Sketch recognition assets unavailable') from exc
    if (hashlib.sha256(raw).hexdigest() != _WEIGHTS_SHA256
            or hashlib.sha256(names).hexdigest() != _CLASSES_SHA256):
        raise RecognitionUnavailable('Sketch recognition asset integrity failure')
    classes = tuple(names.decode('ascii').splitlines())
    if len(classes) != 345 or len(set(classes)) != 345:
        raise RecognitionUnavailable('Sketch recognition class mismatch')
    weights, offset = [], 0
    for shape in _SHAPES:
        count = math.prod(shape)
        weights.append(np.frombuffer(raw, dtype='<f4', count=count, offset=offset).reshape(shape))
        offset += count * 4
    if offset != len(raw) or not all(np.isfinite(w).all() for w in weights):
        raise RecognitionUnavailable('Sketch recognition tensor mismatch')
    return tuple(weights), classes


def _conv(image, kernel, bias):
    np, _, _ = _runtime()
    padded = np.pad(image, ((1, 1), (1, 1), (0, 0)))
    windows = np.lib.stride_tricks.sliding_window_view(padded, (3, 3), axis=(0, 1))
    patches = windows.transpose(0, 1, 3, 4, 2).reshape(-1, kernel.shape[0] * kernel.shape[1] * kernel.shape[2])
    output = patches @ kernel.reshape(-1, kernel.shape[-1]) + bias
    return np.maximum(output, 0).reshape(image.shape[0], image.shape[1], kernel.shape[-1])


def predict_bitmap(bitmap):
    """Evaluate a training-format uint8 28x28 image (white ink on black).

    Used by reproducible offline evaluation; the HTTP route accepts strokes only.
    Scores are global 345-class probabilities, never prompt-bank renormalized.
    """
    np, _, _ = _runtime()
    array = np.asarray(bitmap)
    if array.shape != (28, 28) or array.dtype != np.uint8:
        raise ValueError('Expected one uint8 28 by 28 bitmap')
    if np.count_nonzero(array > 24) < 5:
        return []
    weights, classes = _model()
    image = array.astype(np.float32).reshape(28, 28, 1) / np.float32(255)
    for index in range(6):
        image = _conv(image, weights[index * 2], weights[index * 2 + 1])
        if index % 2:
            h, w, c = image.shape
            image = image[:h // 2 * 2, :w // 2 * 2].reshape(h // 2, 2, w // 2, 2, c).max(axis=(1, 3))
    hidden = np.tanh(image.reshape(576) @ weights[12] + weights[13])
    logits = hidden @ weights[14] + weights[15]
    probs = np.exp(logits - logits.max())
    probs /= probs.sum()
    indexes = np.argsort(-probs, kind='stable')[:5]
    return [{'label': classes[i].replace('_', ' '), 'score': float(probs[i])} for i in indexes]


def render_bitmap(strokes):
    """Composite the actual 800x500 public ink, then center it like QuickDraw.

    Chronological white strokes erase visible ink. All permitted colored brushes
    count as ink. Normalized coordinates preserve the board's aspect ratio.
    """
    np, Image, ImageDraw = _runtime()
    if not isinstance(strokes, list) or len(strokes) > 384:
        raise ValueError('Invalid sketch strokes')
    canvas = Image.new('L', (800, 500), 0)
    draw = ImageDraw.Draw(canvas)
    total = 0
    for stroke in strokes:
        if not isinstance(stroke, dict):
            raise ValueError('Invalid sketch stroke')
        points, color, width = stroke.get('points'), stroke.get('color'), stroke.get('width')
        if (not isinstance(points, list) or not 1 <= len(points) <= 120
                or not isinstance(color, str) or len(color) != 7 or color[0] != '#'
                or type(width) not in (int, float) or not math.isfinite(width) or not 1 <= width <= 12):
            raise ValueError('Invalid sketch brush')
        try:
            int(color[1:], 16)
        except ValueError as exc:
            raise ValueError('Invalid sketch color') from exc
        total += len(points)
        if total > 8000:
            raise ValueError('Sketch point bound exceeded')
        pixels = []
        for point in points:
            if (not isinstance(point, (list, tuple)) or len(point) != 2
                    or any(type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1 for v in point)):
                raise ValueError('Invalid sketch point')
            pixels.append((round(point[0] * 800), round(point[1] * 500)))
        fill = 0 if color.lower() == '#ffffff' else 255
        brush = max(1, round(width))
        if len(pixels) > 1:
            draw.line(pixels, fill=fill, width=brush, joint='curve')
        radius = width / 2
        for x, y in pixels:
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)
    box = canvas.getbbox()
    if box is None or max(box[2] - box[0], box[3] - box[1]) < 12:
        return np.zeros((28, 28), dtype=np.uint8)
    crop = canvas.crop(box)
    # QuickDraw's bitmap conversion uses a standard-width pen. Normalize the
    # already-composited visible ink to that width; thin mouse/finger lines
    # would otherwise vanish when reducing an 800px board to 28px.
    from PIL import ImageFilter
    scale = 96 / max(crop.size)
    resized = crop.resize((max(1, round(crop.width * scale)), max(1, round(crop.height * scale))), Image.Resampling.LANCZOS)
    result = Image.new('L', (112, 112), 0)
    # Preserve faint antialiased samples before standard-width dilation.
    resized = resized.point(lambda value: 255 if value >= 24 else 0)
    result.paste(resized, ((112 - resized.width) // 2, (112 - resized.height) // 2))
    result = result.filter(ImageFilter.MaxFilter(5)).resize((28, 28), Image.Resampling.LANCZOS)
    return np.asarray(result, dtype=np.uint8)


def predict(strokes):
    return predict_bitmap(render_bitmap(strokes))
