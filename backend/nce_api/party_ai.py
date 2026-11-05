"""Small built-in opponents. Input is one seat's projection, not engine state.

No network, providers, shared hidden state or player impersonation. A policy
returns a suggestion and bounded private observation memory; the engine still
validates every suggested action through its normal rules.
"""
from copy import deepcopy
import importlib.util
import math
from pathlib import Path
import secrets
import uuid

_sketch = None
SKETCH_CONFIDENCE = .25
RECOGNITION_LABELS = {
    'hot air balloon': 'hot-air balloon', 'snowman': 'snowman', 'cat': 'sleeping cat',
    'birthday cake': 'birthday cake', 'cake': 'birthday cake', 'roller coaster': 'roller coaster',
    'rainbow': 'rainbow', 'cactus': 'cactus', 'skateboard': 'skateboard', 'dragon': 'dragon',
    'lighthouse': 'lighthouse', 'octopus': 'octopus', 'campfire': 'campfire', 'giraffe': 'giraffe',
    'ice cream': 'ice cream cone', 'sailboat': 'sailboat', 'butterfly': 'butterfly',
    'helicopter': 'helicopter', 'penguin': 'penguin', 'elephant': 'elephant', 'windmill': 'windmill',
    'mountain': 'mountain', 'bicycle': 'bicycle', 'guitar': 'guitar', 'piano': 'piano',
    'umbrella': 'umbrella', 'backpack': 'backpack', 'crab': 'crab', 'castle': 'castle',
    'pizza': 'pizza', 'frog': 'frog', 'moon': 'moon', 'snowflake': 'snowflake',
    'hamburger': 'hamburger', 'whale': 'whale', 'squirrel': 'squirrel', 'crown': 'crown',
    'sea turtle': 'turtle', 'tennis racquet': 'tennis racket',
}


def sketch():
    global _sketch
    if _sketch is None:
        spec = importlib.util.spec_from_file_location('game_studio_sketch_ai', Path(__file__).with_name('sketch_ai.py'))
        _sketch = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_sketch)
    return _sketch


def supported_prompts():
    return tuple(sketch().SUPPORTED_PROMPTS)


def supported_guess_prompts():
    return tuple(sorted(set(RECOGNITION_LABELS.values())))


def rank_recognition(observation):
    """Map a trained tool's public-ink scores through one fixed vocabulary.

    Generic labels never select a hidden subtype: cat is the existing accepted
    alias for sleeping cat; castle always means castle, never sandcastle.
    Raw classifier probabilities are not renormalized over the prompt bank.
    """
    if not isinstance(observation, dict) or not isinstance(observation.get('modelVersion'), str):
        return []
    candidates = observation.get('candidates')
    if not isinstance(candidates, list) or len(candidates) > 5:
        return []
    normalized = lambda text: ''.join(char for char in text.casefold() if char.isalnum())
    labels = {normalized(label): prompt for label, prompt in RECOGNITION_LABELS.items()}
    ranked = {}
    for candidate in candidates:
        if not isinstance(candidate, dict) or set(candidate) != {'label', 'score'}:
            return []
        label, score = candidate['label'], candidate['score']
        if (not isinstance(label, str) or not 1 <= len(label) <= 80 or type(score) not in (int, float)
                or not math.isfinite(score) or not 0 <= score <= 1):
            return []
        prompt = labels.get(normalized(label))
        if prompt and score >= SKETCH_CONFIDENCE:
            ranked[prompt] = max(score, ranked.get(prompt, 0))
    return [prompt for prompt, score in sorted(ranked.items(), key=lambda item: (-item[1], item[0]))]


# A deliberately imperfect general-knowledge vocabulary, matched to the public
# question/options. It does not import the engine's answer indexes or choices.
FACTS = {
    'large rings': 'Saturn', 'mammal': 'Dolphin', 'bees collect': 'Nectar', '88 keys': 'Piano',
    'largest ocean': 'Pacific', 'one and a half hours': '90', 'no corners': 'Circle',
    'swimming but cannot fly': 'Penguin', 'blue and yellow': 'Green', 'named pattern': 'A constellation',
    'grows on a vine': 'Grape', 'standard violin': 'Four', 'L shape': 'Knight', 'only plants': 'Herbivore',
    'main gas': 'Nitrogen', 'shuttlecock': 'Badminton', 'percussion': 'Drum', 'prime number': '17',
    'follows spring': 'Summer', 'baby frog': 'Tadpole', 'magnet': 'Iron', 'standard soccer': 'Eleven',
    'measures temperature': 'Thermometer', 'smallest positive': 'One', 'type of cloud': 'Cumulus',
    'building dams': 'Beaver', 'closest to the Sun': 'Mercury', 'compass needle': 'Magnetic north',
    'legs does a spider': 'Eight', 'distant stars': 'Telescope', 'solid state': 'Ice',
    'woodwind': 'Clarinet', 'three squared': 'Nine', 'caterpillar': 'Butterfly', 'molten rock': 'Lava',
    'North Pole': 'Arctic', 'three equal sides': 'Equilateral', 'two days': '48', 'thick stem': 'Cactus',
}


def _place(board, column, player):
    result = deepcopy(board)
    row = next((row for row in range(5, -1, -1) if result[row][column] is None), None)
    if row is None:
        return None
    result[row][column] = player
    return result


def _windows(board):
    for row in range(6):
        for column in range(7):
            for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1)):
                if 0 <= row + 3 * dr < 6 and 0 <= column + 3 * dc < 7:
                    yield [board[row + step * dr][column + step * dc] for step in range(4)]


def _win(board, player):
    return any(all(cell == player for cell in cells) for cells in _windows(board))


def _score(board, player, opponent):
    score = 3 * sum(row[3] == player for row in board)
    for cells in _windows(board):
        if opponent not in cells:
            score += (0, 1, 8, 50, 100000)[cells.count(player)]
        if player not in cells:
            score -= (0, 1, 8, 60, 100000)[cells.count(opponent)]
    return score


def drop_column(view):
    """Win, block, then compare legal public-board replies (two plies)."""
    board, player = view['game']['board'], view['self']['id']
    opponent = next(item['id'] for item in view['players'] if item['id'] != player and not item.get('left'))
    legal = [column for column in range(7) if board[0][column] is None]
    for identity in (player, opponent):
        wins = [column for column in legal if _win(_place(board, column, identity), identity)]
        if wins:
            return secrets.choice(wins)
    scored = []
    for column in legal:
        own = _place(board, column, player)
        replies = [_place(own, reply, opponent) for reply in range(7) if own[0][reply] is None]
        value = min((_score(reply, player, opponent) for reply in replies), default=_score(own, player, opponent))
        scored.append((value, column))
    return secrets.choice([column for score, column in scored if score == max(item[0] for item in scored)]) if scored else None


def _step(rooms, origin, destination):
    routes = [(origin, [])]
    seen = set()
    graph = {room['id']: room['neighbors'] for room in rooms}
    while routes:
        room, path = routes.pop(0)
        if room == destination:
            return path[0] if path else None
        if room not in seen:
            seen.add(room)
            routes.extend((neighbor, [*path, neighbor]) for neighbor in graph.get(room, []) if neighbor not in seen)
    return None


def _ship(view, memory, now):
    own, game = view['self'], view['game']
    is_alive = own.get('alive') is True
    if not is_alive and own.get('role') != 'crew':
        return None
    player_id, room = own['id'], own['room']
    alive = [player for player in view['players'] if player.get('alive') and not player.get('left')]
    living = {player['id'] for player in alive}
    suspects = [identity for identity in memory.get('suspects', []) if identity in living and identity != player_id]
    if view['phase'] == 'roaming':
        # Infer only from a body's appearance among people previously seen in
        # this bot's own room. Never consult another player's private role.
        previous = memory.get('nearby', [])
        known_bodies = memory.get('bodies', [])
        for body in game.get('bodies', []):
            if body['playerId'] not in known_bodies and body['room'] == memory.get('room'):
                candidates = [identity for identity in previous if identity != body['playerId'] and identity in living]
                if len(candidates) == 1:
                    suspects.append(candidates[0])
        memory.update(nearby=[item['id'] for item in game['positions'] if item['room'] == room and item['alive'] and item['id'] != player_id][:6],
                      room=room, bodies=[body['playerId'] for body in game.get('bodies', [])][-8:],
                      suspects=list(dict.fromkeys(suspects))[-4:])
    if view['phase'] == 'discussion':
        if is_alive and player_id not in game['readyIds'] and now >= memory['phaseSince'] + 6:
            return {'type': 'ready'}
        return None
    if view['phase'] == 'voting':
        if is_alive and own.get('vote') is None:
            teammates = set(own.get('teammateIds', []))
            candidates = [identity for identity in suspects if identity not in teammates]
            if not candidates:
                candidates = [identity for identity in living if identity != player_id and identity not in teammates]
                if secrets.randbelow(3):
                    return {'type': 'vote', 'targetId': 'skip'}
            return {'type': 'vote', 'targetId': secrets.choice(candidates) if candidates else 'skip'}
        return None
    if view['phase'] != 'roaming':
        return None
    bodies = [body for body in game.get('bodies', []) if body['room'] == room]
    if is_alive and bodies:
        return {'type': 'report', 'targetId': bodies[0]['playerId']}
    if own['role'] == 'impostor':
        teammates = set(own.get('teammateIds', []))
        targets = [item for item in game['positions'] if item['alive'] and item['id'] != player_id and item['id'] not in teammates]
        nearby = [item for item in targets if item['room'] == room]
        if nearby and now >= own.get('tagReadyAt', now + 1):
            return {'type': 'tag', 'targetId': secrets.choice(nearby)['id']}
        if not game.get('sabotage') and now >= own.get('sabotageReadyAt', now + 1):
            return {'type': 'sabotage'}
        destination = secrets.choice(targets)['room'] if targets else room
    else:
        if is_alive and game.get('sabotage'):
            if room == 'reactor' and now >= own.get('taskReadyAt', 0):
                return {'type': 'repair', 'step': game['sabotage']['progress']}
            destination = 'reactor'
        else:
            unfinished = [task for task in own['tasks'] if not task['complete']]
            if not unfinished:
                destination = secrets.choice(game['rooms'])['id']
            else:
                task = next((task for task in unfinished if task['room'] == room), unfinished[0])
                if task['room'] == room and now >= own.get('taskReadyAt', 0):
                    return {'type': 'task', 'taskId': task['id'], 'step': task['sequence'][task['progress']]}
                destination = task['room']
    if now >= own.get('moveReadyAt', 0):
        step = _step(game['rooms'], room, destination)
        if step:
            return {'type': 'move', 'room': step}
    return None


def _drawing(view, memory, now):
    game, own = view['game'], view['self']
    if view['phase'] != 'draw':
        return None
    if game['artistId'] == own['id']:
        template = sketch().drawing_for(own.get('prompt', ''))
        offset = memory.get('drawIndex', 0)
        segments = template[offset:offset + 3]
        if segments:
            memory['drawIndex'] = offset + len(segments)
            return {'type': 'drawing-batch', 'drawingEpoch': game.get('drawingEpoch', 0),
                    'segments': [{'id': str(uuid.uuid5(uuid.UUID(own['id']), str(view['phaseId']) + ':'
                                + str(game.get('drawingEpoch', 0)) + ':' + str(offset + index))), **segment}
                                 for index, segment in enumerate(segments)]}
        return None
    strokes = game.get('strokes', [])
    if own['id'] in game.get('guessedIds', []):
        return None
    has_ink = any(isinstance(stroke, dict) and str(stroke.get('color', '')).lower() != '#ffffff'
        and stroke.get('points') for stroke in strokes)
    version = [game.get('drawingEpoch', 0), len(strokes), sum(len(stroke.get('points', [])) for stroke in strokes), strokes[-1].get('id', '') if strokes else '']
    prior = memory.get('inkVersion')
    if not has_ink or isinstance(prior, list) and prior and prior[0] != version[0]:
        for key in ('firstInkAt', 'pendingLabel', 'pendingSince'):
            memory.pop(key, None)
    if memory.get('inkVersion') != version:
        memory.update(inkVersion=version, inkChangedAt=now)
    if not has_ink:
        return None
    memory.setdefault('firstInkAt', now)
    guesses = memory.get('guesses', [])
    if len(guesses) >= 3:
        return None
    options = [label for label in rank_recognition(game.get('recognition')) if label not in guesses]
    if not options:
        memory.pop('pendingLabel', None); memory.pop('pendingSince', None)
        return None
    if memory.get('pendingLabel') != options[0] or type(memory.get('pendingSince')) not in (int, float):
        memory.update(pendingLabel=options[0], pendingSince=now)
    # Early partial doodles are often confidently wrong. Wait for public ink
    # to develop and for a label to remain stable; a quiet cached result also
    # qualifies, without repeating inference or looking at the secret prompt.
    # Keep the normal development/stability waits, but leave one final bounded
    # opportunity when the artist starts late. A newly seen label still needs
    # at least a full second; no hidden answer affects this public deadline gate.
    first_ready = min(memory['firstInkAt'] + 8, max(memory['firstInkAt'] + 1, view['deadlineAt'] - 2))
    stable_ready = min(memory['pendingSince'] + 3, max(memory['pendingSince'] + 1, view['deadlineAt'] - 1))
    if now < first_ready or now < stable_ready:
        return None
    if guesses and now < memory.get('lastGuessAt', 0) + 6:
        return None
    if len(guesses) >= 2:
        # Keep one attempt for a finished or substantially developed drawing.
        # Only public ink changes and the public round deadline influence this
        # gate; the human artist's private prompt never enters the policy.
        seconds = view['settings']['roundSeconds']
        reserve_at = view['deadlineAt'] - seconds * .25
        if now < memory['inkChangedAt'] + 6 and now < reserve_at:
            return None
    if options:
        memory['guesses'] = [*guesses, options[0]][-3:]
        memory['lastGuessAt'] = now
        return {'type': 'guess', 'text': options[0]}
    return None


def decide(view, memory, now):
    """Return (validated-action suggestion or None, bounded observation memory)."""
    memory = deepcopy(memory) if isinstance(memory, dict) else {}
    if view.get('status') != 'playing':
        return None, memory
    if memory.get('phaseId') != view['phaseId']:
        for key in ('drawIndex', 'guesses', 'firstInkAt', 'lastGuessAt', 'inkVersion', 'inkChangedAt', 'pendingLabel', 'pendingSince'):
            memory.pop(key, None)
        memory.update(phaseId=view['phaseId'], phaseSince=now)
    own, game, kind = view['self'], view['game'], view['kind']
    action = None
    if kind == 'hand-duel' and view['phase'] == 'choose' and own.get('choice') is None:
        action = {'type': 'choose', 'choice': secrets.choice(('rock', 'paper', 'scissors'))}
    elif kind == 'drop-four' and view['phase'] == 'turn' and game.get('turnId') == own['id']:
        column = drop_column(view)
        if column is not None:
            action = {'type': 'drop', 'column': column}
    elif kind == 'trivia' and view['phase'] == 'question' and own.get('answer') is None:
        question = game['question']
        known = next((answer for clue, answer in FACTS.items() if clue.casefold() in question['text'].casefold() and answer in question['options']), None)
        if known is not None and secrets.randbelow(4):
            answer = question['options'].index(known)
        else:
            answer = secrets.randbelow(4)
        action = {'type': 'answer', 'answer': answer}
    elif kind == 'starship-suspects':
        action = _ship(view, memory, now)
    elif kind == 'sketch-guess':
        action = _drawing(view, memory, now)
    return action, memory
