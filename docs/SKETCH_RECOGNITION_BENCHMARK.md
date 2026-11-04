# Sketch recognition: public human-drawing evaluation

The benchmark compares the previous fixed-template matcher with the local
trained classifier. Predictors receive only public ink or a bitmap. The category
label is used afterward for scoring; neither predictor receives a room, current
prompt, correct answer, role, chat message or user identifier.

## Frozen data and distinct claims

The data comes from Google's [Quick, Draw! dataset](https://github.com/googlecreativelab/quickdraw-dataset),
licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The
official documentation describes its category-specific simplified strokes and
28×28 grayscale bitmap files. The preparation tool records the source URL,
immutable object generation, ETag, exact byte range and content SHA-256. Dataset
documentation is pinned privately to repository commit
`5fe6c0a910b3732bc3db7639d3c9e7c287617f2f`.

Two separate datasets support different conclusions:

- **Documented-recipe-heldout bitmaps:** 40 rows per class, indices
  50,000–50,039, across 38 covered game categories and six unrelated negative
  categories. The author's [training notebook](https://github.com/yining1023/doodleNet/blob/7a4708e4d2be126d30679807b85ac5f5489c09f5/doodleNet.ipynb)
  loads the first 50,000 bitmap rows per category before shuffling and splitting
  them. These evaluation rows are outside that documented recipe. The published
  weights' complete training lineage and exact duplicate-image overlap are not
  independently established.
- **Human-stroke validation:** 40 drawings each from 24 representative categories,
  selected by a fixed hash of category and drawing ID from a bounded tail window.
  Selection never filters on the original game's `recognized` result. This set
  contains both recognized and unrecognized drawings. Alignment between stroke
  rows and bitmap row order is unproven, so this dataset is explicitly marked
  **training overlap unverified** and is not called train-disjoint heldout data.

The fixed specification is [sketch-recognition-benchmark.json](../config/sketch-recognition-benchmark.json).
Category mappings are explicit and include declared aliases such as `cat` for
the game's accepted `sleeping cat` answer. Exact labels and declared aliases are
reported separately. Compound prompts without a supported class are excluded
from the accuracy denominator and remain visible in coverage documentation.

All human drawing files, provenance, frozen template source, model outputs and
sample-level results remain in the private evaluation directory outside Git.
The repository contains only tooling, the fixed class/split specification and
synthetic tooling tests. No player drawing or production record is collected.

## Calibration and acceptance

The first 20 bitmap rows and first 20 hash-ordered stroke records per category
are calibration data. The remaining 20 are the acceptance slice. Pen widths and
confidence thresholds are selected only on calibration, then the production
renderer and threshold are frozen before acceptance scoring.

Stroke tests expose 25%, 50%, 75% and 100% of the ordered point sequence. A prefix
can end inside a stroke; future points and the final drawing's bounding box are
not supplied. Coordinates place the original square drawing in the center of
the actual 800×500 board, preserving physical proportions. Long strokes use the
same bounded, overlapping wire segments as the game.

The bitmap comparison also declares a necessary adapter for the previous
matcher: foreground pixels become horizontal vector runs. That historical
matcher did not accept bitmap files. The human-stroke comparison calls both
models' actual vector interfaces and is the relevant test of the complete
rendering path.

Reports include top-one and top-three game-answer accuracy, guess coverage,
negative-category false guesses, exact/alias strata, per-category results,
partial-prefix results and local latency. Scores remain global classifier
probabilities; they are not renormalized among game prompts. Early partial ink
can resemble another complete object, so partial accuracy does not establish a
safe guessing schedule by itself.

## Acceptance results

Calibration selected a five-pixel standardization filter and a global score
threshold of 0.25. Those settings and NumPy 2.5.4/Pillow 13.0.0 were frozen before
the separate acceptance slice was scored. No acceptance tuning was performed.

| Evaluation input | Samples | Previous matcher, top three | Trained classifier, top three |
| --- | ---: | ---: | ---: |
| Complete human strokes | 480 | 28.3% | 68.1% |
| First 75% of human stroke points | 480 | 25.2% | 50.6% |
| First 50% of human stroke points | 480 | 14.2% | 19.2% |
| First 25% of human stroke points | 480 | 9.2% | 1.9% |
| Documented-recipe-heldout bitmap rows | 760 mapped positives | 24.1% with raster adapter | 77.6% |

The classifier abstained on 89.4% of quarter-drawing prefixes. Such early ink is
still unreliable; the benchmark supports waiting for more ink and does not
claim that a partial-object guess is accurate. On complete human drawings,
327 of 335 drawings receiving a classifier guess had the correct answer among
those guesses (97.6%); abstentions remain in the 68.1% overall denominator.

Nine of 120 unrelated-category bitmaps produced a mapped game guess (7.5%).
Exact-label and declared-alias groups, class coverage, frozen hashes and all
aggregate denominators are in
[the aggregate results](SKETCH_RECOGNITION_BENCHMARK_RESULTS.json). Private
sample-level reports retain the separate training-overlap qualifications above.
The local Mac's median inference time was about 2 ms; this is not a production
Lambda latency measurement.

## Run locally

Both tools default to offline planning. Explicit data preparation downloads about
8 MB of public data; it does not execute repository downloads, load pickle,
train a model, invoke a paid provider or access production.

```sh
python3 scripts/sketch-recognition-benchmark-data.py
python3 scripts/sketch-recognition-benchmark-data.py --download
python3 scripts/benchmark-sketch-recognition.py
```

Use the evaluation virtual environment with the release's pinned NumPy/Pillow
versions for execution. Freeze the original repository `sketch_ai.py` as the
private `template-baseline.py` before testing. Run separate calibration variants
with `--run --split calibration --pen-diameter 3`, `5` and `7`. After selecting
and freezing the production renderer, run `--run --split acceptance --threshold`
with the selected threshold. Acceptance refuses a calibration pen override.

Frozen manifests and result files cannot be overwritten. Each result binds the
data manifest, baseline source, classifier source and exact runtime versions.
Network APIs are disabled during inference. Synthetic parser, split, selection
and label-blindness guards run under the ordinary scripts test suite.
