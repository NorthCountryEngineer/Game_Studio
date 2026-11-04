# Trained drawing recognition

Sketch & Guess uses the pretrained DoodleNet convolutional classifier to turn
visible ink into five global class probabilities. The existing game agent maps
those candidates through a fixed vocabulary and makes at most three legal
guesses. No language model or paid AI provider is called during play. Inference
uses the existing service's CPU; ordinary request and compute usage still apply.

The classifier receives only chronological public colors, brush widths and
points. It never receives a room, player names, secret prompt, answer aliases,
score, or private messages. White eraser strokes cover previous ink before the
image is centered, its pen width normalized, and reduced to 28 by 28 pixels.
Colored brushes have the same geometry. No camera or uploaded picture is needed.

New games and rematches with AI draw from 38 existing supported prompts. Human-only
games retain all 60. Existing running rounds and their answers/order are retained.
The classifier has 345 global classes; its scores are never renormalized over the
38-word game bank. Unsupported and low-confidence candidates are discarded.
The model can still be wrong, particularly on incomplete drawings; see the
[frozen human-drawing benchmark](SKETCH_RECOGNITION_BENCHMARK.md).

## Separate recognition requests

Human room clients schedule a low-priority request independently of the drawing
and action queues. Normal room polls and drawing submissions never import the
vision runtime or run inference. A slow classifier cannot hold the drawing queue,
advance an action sequence, or replace a room snapshot. One client request is in
flight at a time; changed ink coalesces, context changes abort old requests, and
busy/network retries are bounded. Clients do not submit pixels, labels or scores.

`POST /party/rooms/{roomId}/recognition` requires an active human seat capability
and exactly `{phaseId, drawingEpoch, inkSha256}` from the current public drawing.
The service claims that exact public-ink identity through a conditional write,
releases storage for inference, then conditionally saves candidates only if the
phase, clear epoch, ink hash and job owner are still current. No model work runs
inside a conditional-write retry. Clear/leave/close/new ink discard stale work.
Responses contain only a versioned acknowledgement, never observations or room
snapshots. Humans cannot publish their own recognition scores.

One room shares a 20-inference budget per phase across all tabs and seats, with
3–9 seconds between jobs depending on round duration and a 10-second claim lease.
Only one current bounded private observation is retained; no raster or inference
history is persisted. Missing/corrupt assets, timeout, or unavailable dependencies
cause abstention. There is no template fallback or secret-answer fallback.

The guesser waits at least eight seconds after first visible ink and three seconds
of candidate stability, allows six seconds between guesses, and reserves its last
attempt for a quiet drawing or the final quarter of the turn. Clearing resets its
ink/stability timer while retaining the phase's three-guess budget.

## Model provenance and local packaging

Weights and labels are pinned to the MIT-distributed
[ml5 DoodleNet mirror](https://github.com/ml5js/ml5-data-and-models/tree/0612a3e7c51cbffdc5db701dff49d16d1ac26fa8/models/doodlenet).
The bundled manifest records full source hashes and includes its MIT notice.
Training data attribution: Google Creative Lab and contributors,
[Quick, Draw! dataset](https://github.com/googlecreativelab/quickdraw-dataset),
Creative Commons Attribution 4.0. No training or fine-tuning is performed here.
The fixed NumPy implementation reads hash-verified float32 tensors, not a
deserialized executable model graph. Six convolutions, three pools and two dense
layers contain 544,201 parameters. Independent original TensorFlow.js parity
checks matched all top-five labels on four bitmap inputs, with probability
differences below 0.000002, including the final Linux ARM64 archive.

Install local dependencies with `python -m pip install -r
backend/requirements-sketch-vision.txt`. `scripts/prepare-sketch-runtime.py` plans
offline by default. Its explicit `--download` fetches exactly two hash-pinned
public PyPI wheels for Python 3.12/Linux ARM64. `scripts/package-api.py` then
builds a deterministic archive offline, including model attribution and the
verified NumPy/Pillow wheels. It rejects missing/corrupt wheels, unsafe archive
paths, symlinks, collisions and size overflows. No cloud settings change.

A local official Python 3.12 ARM64 Lambda container was run without networking,
at 256 MB and 0.15 CPU, to verify the native dependencies and predictions. This
is a constrained local rehearsal; actual production duration and memory still
require authorized live verification. See the release plan for exact artifact
hashes and measurements. Public provider calls, training endpoints, new IAM,
new infrastructure, and browser model downloads are unnecessary.
