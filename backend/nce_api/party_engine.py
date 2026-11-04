"""Pure, server-owned party rules. No network, storage or provider calls.

Every exported transition returns a deep copy; input state is never changed.
The API owns authentication, capability hashes, admission and idempotency. It
must persist reconcile() on reads before applying a phase-bound action. Timestamps
are integer Unix seconds. project() is an explicit allowlist, never raw state.
"""
from collections import Counter
from copy import deepcopy
import hashlib
import json
import importlib.util
from pathlib import Path
import re
import secrets
import time
import unicodedata
import uuid

AVATARS = ('fox', 'bear', 'cat', 'dog', 'rabbit', 'panda', 'tiger', 'lion', 'frog', 'owl',
           'koala', 'unicorn', 'dragon', 'robot', 'alien', 'ghost', 'octopus', 'penguin', 'monkey', 'butterfly')
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
CATALOG_PATH = Path(__file__).with_name('party-games.json')
if not CATALOG_PATH.exists():
    CATALOG_PATH = Path(__file__).resolve().parents[2] / 'config/party-games.json'
CATALOG = json.loads(CATALOG_PATH.read_text(encoding='utf-8'))['games']
GAMES = {item['id']: item for item in CATALOG if item['id'] != 'mafia'}
# Drawing is streamed in small batches. Compact old geometry rather than making
# an artist stop/clear mid-turn; this also leaves room for seats/chat in the
# adapter's 320 KB payload and DynamoDB's 400 KB item limit.
DRAWING_BATCH_SEGMENTS = 6
DRAWING_SEGMENT_POINTS = 120
DRAWING_STROKES = 384
DRAWING_POINTS = 8000
DRAWING_BYTES = 120000
DRAWING_ACK_IDS = 128
AI_ACTIONS_PER_TICK = 8
AI_MEMORY_BYTES = 1024
_ai_rules = None


def ai_rules():
    global _ai_rules
    if _ai_rules is None:
        spec = importlib.util.spec_from_file_location('game_studio_party_ai', Path(__file__).with_name('party_ai.py'))
        _ai_rules = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_ai_rules)
    return _ai_rules
DEFAULTS = {
    'starship-suspects': {'maxPlayers': 12, 'rounds': 1, 'roundSeconds': 45},
    'sketch-guess': {'maxPlayers': 12, 'rounds': 6, 'roundSeconds': 75},
    'trivia': {'maxPlayers': 24, 'rounds': 8, 'roundSeconds': 30},
    'hand-duel': {'maxPlayers': 2, 'rounds': 5, 'roundSeconds': 45},
    'drop-four': {'maxPlayers': 2, 'rounds': 1, 'roundSeconds': 120},
}
ROOMS = [
    {'id': 'bridge', 'title': 'Bridge', 'x': .5, 'y': .12, 'neighbors': ['medbay', 'storage']},
    {'id': 'medbay', 'title': 'Medbay', 'x': .18, 'y': .4, 'neighbors': ['bridge', 'reactor', 'storage']},
    {'id': 'storage', 'title': 'Storage', 'x': .8, 'y': .4, 'neighbors': ['bridge', 'medbay', 'engine']},
    {'id': 'reactor', 'title': 'Reactor', 'x': .25, 'y': .8, 'neighbors': ['medbay', 'engine']},
    {'id': 'engine', 'title': 'Engine', 'x': .73, 'y': .8, 'neighbors': ['storage', 'reactor']},
]
STATIONS = ['medbay', 'storage', 'engine', 'reactor', 'bridge']
SYMBOLS = ['●', '▲', '■', '★']
PROMPTS = [
    ('hot-air balloon', ['balloon']), ('snowman', []), ('treehouse', ['tree house']),
    ('pirate ship', []), ('sleeping cat', ['cat']), ('robot', []), ('birthday cake', ['cake']),
    ('roller coaster', []), ('spaceship', ['space ship']), ('rainbow', []), ('turtle', []),
    ('cactus', []), ('volcano', []), ('jellyfish', []), ('skateboard', []), ('waterfall', []),
    ('dragon', []), ('lighthouse', []), ('octopus', []), ('campfire', []), ('giraffe', []),
    ('sandcastle', ['sand castle']), ('ice cream cone', ['ice cream']), ('sailboat', ['sail boat']),
    ('dinosaur', []), ('butterfly', []), ('treasure chest', []), ('helicopter', []),
    ('bowling', []), ('penguin', []), ('pancakes', ['pancake']), ('rocket', []),
    ('elephant', []), ('rain boots', ['boots']), ('unicycle', []), ('windmill', []),
    ('sunflower', []), ('sunglasses', []), ('mountain', []), ('bicycle', ['bike']),
    ('guitar', []), ('piano', []), ('telescope', []), ('umbrella', []), ('backpack', []),
    ('crab', []), ('fireworks', []), ('castle', []), ('pizza', []), ('magic wand', ['wand']),
    ('frog', []), ('fishing rod', []), ('moon', []), ('snowflake', []), ('hamburger', ['burger']),
    ('whale', []), ('Ferris wheel', []), ('squirrel', []), ('tennis racket', []), ('crown', []),
]
# Original, fixed general-interest prompts. Answers never enter a question-phase
# projection; only question text/options and the caller's own choice are public.
TRIVIA = [
    ('Which planet is famous for its large rings?', ['Mars', 'Saturn', 'Mercury', 'Venus'], 1),
    ('How many sides does a hexagon have?', ['Five', 'Six', 'Seven', 'Eight'], 1),
    ('Which animal is a mammal?', ['Shark', 'Octopus', 'Dolphin', 'Trout'], 2),
    ('What do bees collect from flowers to make honey?', ['Nectar', 'Sand', 'Salt', 'Bark'], 0),
    ('Which instrument usually has 88 keys?', ['Flute', 'Violin', 'Trumpet', 'Piano'], 3),
    ('What is the largest ocean on Earth?', ['Atlantic', 'Arctic', 'Pacific', 'Indian'], 2),
    ('How many minutes are in one and a half hours?', ['60', '75', '90', '120'], 2),
    ('Which shape has no corners?', ['Triangle', 'Circle', 'Rectangle', 'Pentagon'], 1),
    ('Which bird is known for swimming but cannot fly?', ['Eagle', 'Sparrow', 'Penguin', 'Hawk'], 2),
    ('Which color is made by mixing blue and yellow paint?', ['Green', 'Orange', 'Purple', 'Red'], 0),
    ('What is a group of stars forming a named pattern called?', ['A tide', 'A constellation', 'A crater', 'A comet'], 1),
    ('Which fruit grows on a vine?', ['Apple', 'Pear', 'Cherry', 'Grape'], 3),
    ('How many strings does a standard violin have?', ['Three', 'Four', 'Five', 'Six'], 1),
    ('Which chess piece moves in an L shape?', ['Bishop', 'Rook', 'Knight', 'Queen'], 2),
    ('What do you call an animal that eats only plants?', ['Herbivore', 'Carnivore', 'Omnivore', 'Predator'], 0),
    ('What is the main gas in the air around us?', ['Oxygen', 'Helium', 'Nitrogen', 'Hydrogen'], 2),
    ('Which sport uses a shuttlecock?', ['Baseball', 'Badminton', 'Golf', 'Hockey'], 1),
    ('Which of these is a percussion instrument?', ['Clarinet', 'Harp', 'Oboe', 'Drum'], 3),
    ('Which number is a prime number?', ['9', '15', '17', '21'], 2),
    ('Which season follows spring?', ['Autumn', 'Winter', 'Summer', 'Spring again'], 2),
    ('What is the name for a baby frog?', ['Cub', 'Tadpole', 'Foal', 'Chick'], 1),
    ('Which material is commonly attracted by a magnet?', ['Glass', 'Wood', 'Iron', 'Paper'], 2),
    ('How many players does each team field in standard soccer?', ['Seven', 'Nine', 'Ten', 'Eleven'], 3),
    ('Which object measures temperature?', ['Compass', 'Thermometer', 'Ruler', 'Scale'], 1),
    ('What is the smallest positive whole number?', ['Zero', 'One', 'Two', 'Ten'], 1),
    ('Which of these is a type of cloud?', ['Granite', 'Cumulus', 'Quartz', 'Basalt'], 1),
    ('Which animal is famous for building dams?', ['Beaver', 'Fox', 'Otter', 'Badger'], 0),
    ('Which planet is closest to the Sun?', ['Earth', 'Venus', 'Mercury', 'Mars'], 2),
    ('What does a compass needle normally point toward?', ['Sunset', 'Magnetic north', 'The nearest ocean', 'The Moon'], 1),
    ('How many legs does a spider have?', ['Four', 'Six', 'Eight', 'Ten'], 2),
    ('Which device lets you look at distant stars?', ['Microscope', 'Periscope', 'Telescope', 'Stethoscope'], 2),
    ('What do we call water in its solid state?', ['Steam', 'Mist', 'Ice', 'Rain'], 2),
    ('Which of these is a woodwind instrument?', ['Trombone', 'Clarinet', 'Cello', 'Cymbal'], 1),
    ('What is three squared?', ['Six', 'Eight', 'Nine', 'Twelve'], 2),
    ('Which animal changes from a caterpillar?', ['Butterfly', 'Ladybug', 'Grasshopper', 'Dragonfly'], 0),
    ('What is the name for molten rock after it reaches the surface?', ['Clay', 'Lava', 'Chalk', 'Coal'], 1),
    ('Which ocean surrounds the North Pole?', ['Pacific', 'Southern', 'Atlantic', 'Arctic'], 3),
    ('Which of these words names a triangle with three equal sides?', ['Scalene', 'Equilateral', 'Obtuse', 'Right'], 1),
    ('How many hours are in two days?', ['24', '36', '48', '72'], 2),
    ('Which plant is known for storing water in its thick stem?', ['Fern', 'Cactus', 'Moss', 'Grass'], 1),
]


class PartyError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message
        super().__init__(message)


def fail(message, status=400):
    raise PartyError(status, message)


def catalog():
    return deepcopy(CATALOG)


def _now(value):
    value = int(time.time()) if value is None else value
    if type(value) not in (int, float) or value < 0 or value > 100000000000 or value != value:
        fail('Invalid room time.')
    return int(value)


def _identifier(value):
    if not isinstance(value, str) or not UUID.fullmatch(value):
        fail('Invalid player identifier.')
    return value


def _text(value, maximum, label):
    if not isinstance(value, str):
        fail(label + ' must be text.')
    if any(unicodedata.category(char) in {'Cc', 'Cs', 'Zl', 'Zp'} or '\u202a' <= char <= '\u202e' or '\u2066' <= char <= '\u2069' for char in value):
        fail(label + ' cannot contain control characters.')
    value = unicodedata.normalize('NFC', value).strip()
    if not 1 <= len(value) <= maximum or not any(unicodedata.category(char)[0] in 'LNPS' for char in value):
        fail(label + ' is outside its allowed length.')
    return value


def validate_player(player):
    if not isinstance(player, dict) or set(player) != {'id', 'name', 'avatar'}:
        fail('Expected a player name and avatar.')
    if player['avatar'] not in AVATARS:
        fail('Choose an available avatar.')
    return {'id': _identifier(player['id']), 'name': _text(player['name'], 16, 'Player name'), 'avatar': player['avatar']}


def validate_settings(kind, value=None, current=None):
    if not isinstance(kind, str) or kind not in GAMES:
        fail('Choose an available party game.')
    if value is None:
        value = {}
    if not isinstance(value, dict) or set(value) - {'maxPlayers', 'rounds', 'roundSeconds'}:
        fail('Unsupported party settings.')
    result = {**(current or DEFAULTS[kind]), **value}
    bounds = {'maxPlayers': (GAMES[kind]['minPlayers'], GAMES[kind]['maxPlayers']),
              'rounds': (1, min(24, len(TRIVIA))), 'roundSeconds': (15, 180)}
    if kind == 'starship-suspects':
        bounds['rounds'] = (1, 1)
    if kind == 'drop-four':
        bounds['rounds'] = (1, 1)
    if kind == 'hand-duel':
        bounds['rounds'] = (5, 5)
    for key, (low, high) in bounds.items():
        if type(result.get(key)) is not int or not low <= result[key] <= high:
            fail('Party settings are outside their allowed range.')
    return result


def _player(state, player_id):
    for player in state['players']:
        if player['id'] == player_id:
            return player
    fail('Your seat is no longer in this room.', 403)


def _active(state):
    return [player for player in state['players'] if not player.get('left')]


def _living(state):
    return [player for player in _active(state) if player['alive']]


def _host(state, actor_id):
    if actor_id != state['hostId']:
        fail('Only the room creator can do that.', 403)


def _emit(state, text, now):
    state['_sequence'] += 1
    state['events'].append({'id': 'e' + str(state['_sequence']), 'text': text, 'at': now})
    state['events'] = state['events'][-60:]


def _phase(state, phase, now, seconds=None):
    if state.get('kind') == 'sketch-guess':
        for key in ('_recognition', '_recognitionJob', '_recognitionBudget', '_inkSha256'):
            state.get('_game', {}).pop(key, None)
    state.update(phase=phase, phaseId=state['phaseId'] + 1, phaseStartedAt=now,
                 deadlineAt=now + seconds if seconds else None)


def _finish(state, winner, text, now):
    state['status'] = 'finished'
    state['winner'] = winner
    _phase(state, 'finished', now)
    _emit(state, text, now)


def _leaders(state):
    active = _active(state)
    best = max((player['score'] for player in active), default=0)
    leaders = [player for player in active if player['score'] == best]
    return leaders[0]['id'] if len(leaders) == 1 else 'draw'


def new_room(owner, kind, settings=None, now=None):
    now = _now(now)
    owner = validate_player(owner)
    if not isinstance(kind, str) or kind not in GAMES:
        fail('Choose an available party game.')
    return {'version': 1, 'roomId': None, 'kind': kind, 'hostId': owner['id'],
            'status': 'lobby', 'phase': 'lobby', 'phaseId': 0, 'round': 0,
            'players': [{**owner, 'alive': True, 'left': False, 'score': 0}],
            'settings': validate_settings(kind, settings), 'createdAt': now,
            'phaseStartedAt': now, 'deadlineAt': None, 'winner': None,
            'events': [], 'chat': [], '_sequence': 0, '_messageTimes': {}, '_game': {}}


def add_player(state, player, now=None):
    now = _now(now)
    player = validate_player(player)
    state = deepcopy(state)
    if state['status'] != 'lobby':
        fail('This game has already started. Ask the host for a rematch.', 409)
    if any(item['id'] == player['id'] for item in state['players']):
        fail('That seat is already in this room.', 409)
    if any(item['name'].casefold() == player['name'].casefold() for item in _active(state)):
        fail('Choose a different name so everyone can tell you apart.', 409)
    # Retired lobby seats are removed so repeat admission never grows the record.
    state['players'] = _active(state)
    if len(state['players']) >= state['settings']['maxPlayers']:
        fail('This room is full.', 409)
    state['players'].append({**player, 'alive': True, 'left': False, 'score': 0})
    _emit(state, player['name'] + ' joined the room.', now)
    return state


def _chat(state, actor, text, now):
    text = _text(text, 160, 'Message')
    times = [at for at in state['_messageTimes'].get(actor['id'], []) if at > now - 60]
    if len(times) >= 12:
        fail('Wait a moment before sending another message.', 429)
    state['_messageTimes'][actor['id']] = times + [now]
    state['_sequence'] += 1
    state['chat'].append({'id': 'c' + str(state['_sequence']), 'playerId': actor['id'],
                          'name': actor['name'], 'text': text, 'at': now})
    state['chat'] = state['chat'][-60:]


def _shuffle(values):
    secrets.SystemRandom().shuffle(values)
    return values


def _start(state, now):
    count = len(_active(state))
    if not GAMES[state['kind']]['minPlayers'] <= count <= state['settings']['maxPlayers']:
        fail('Invite at least ' + str(GAMES[state['kind']]['minPlayers']) + ' players before starting.', 409)
    state['players'] = _active(state)
    for player in state['players']:
        player.update(alive=True, score=0)
    state.update(status='playing', winner=None, round=1, chat=[], _messageTimes={})
    if any(player.get('isAI') is True for player in state['players']):
        state['_ai'] = {player['id']: {'nextAt': now + 2, 'phaseId': -1, 'memory': {}}
                        for player in state['players'] if player.get('isAI') is True}
    kind = state['kind']
    if kind == 'starship-suspects':
        _start_ship(state, now)
    elif kind == 'drop-four':
        state['_game'] = {'board': [[None] * 7 for _ in range(6)], 'turnId': state['players'][0]['id'],
                          'winningCells': [], 'result': None}
        _phase(state, 'turn', now, state['settings']['roundSeconds'])
    elif kind == 'hand-duel':
        state['_game'] = {'choices': {}, 'result': None}
        _phase(state, 'choose', now, state['settings']['roundSeconds'])
    elif kind == 'trivia':
        state['_game'] = {'order': _shuffle(list(range(len(TRIVIA))))[:state['settings']['rounds']], 'answers': {}, 'result': None}
        _phase(state, 'question', now, state['settings']['roundSeconds'])
    elif kind == 'sketch-guess':
        indexes = list(range(len(PROMPTS)))
        if state.get('_ai'):
            supported = set(ai_rules().supported_prompts()) & set(ai_rules().supported_guess_prompts())
            indexes = [index for index, (prompt, _) in enumerate(PROMPTS) if prompt in supported]
            if not indexes:
                fail('The computer drawing library is unavailable.', 503)
        order = _shuffle(indexes)
        order = (order * (1 + state['settings']['rounds'] // len(order)))[:state['settings']['rounds']]
        state['_game'] = {'order': order,
                          'strokes': [], 'guessedIds': [], 'lastStrokeAt': {}, 'clearCount': 0,
                          'drawingEpoch': 0, 'drawingAckIds': [], 'artistId': state['players'][0]['id']}
        _phase(state, 'draw', now, state['settings']['roundSeconds'])
    _emit(state, GAMES[kind]['title'] + ' started. Have fun!', now)


def _artist(state):
    return state['_game'].get('artistId')


def recognition_eligible(state):
    """Only a live drawing with a computer guesser needs recognition work."""
    if state.get('kind') != 'sketch-guess' or state.get('status') != 'playing' or state.get('phase') != 'draw':
        return False
    game, runtime = state['_game'], state.get('_ai', {})
    return any(player.get('isAI') is True and not player.get('left')
        and player['id'] != game.get('artistId') and player['id'] not in game.get('guessedIds', [])
        and len(runtime.get(player['id'], {}).get('memory', {}).get('guesses', [])) < 3
        for player in state['players'])


def recognition_strokes(state):
    """The model's complete allowlist: public ink, without identities or context."""
    return [{key: deepcopy(stroke[key]) for key in ('color', 'width', 'points')}
        for stroke in state['_game'].get('strokes', [])]


def recognition_binding(state):
    if not recognition_eligible(state) or not state['_game'].get('strokes'):
        return None
    game = state['_game']
    ink_hash = game.get('_inkSha256')
    if not isinstance(ink_hash, str) or not re.fullmatch('[a-f0-9]{64}', ink_hash):
        ink_hash = hashlib.sha256(json.dumps(recognition_strokes(state), sort_keys=True,
            separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode()).hexdigest()
    return {'phaseId': state['phaseId'], 'drawingEpoch': game.get('drawingEpoch', 0), 'inkSha256': ink_hash}


def _refresh_recognition_ink(state):
    game = state['_game']
    game.pop('_recognition', None)
    game.pop('_inkSha256', None)
    binding = recognition_binding(state)
    if binding: game['_inkSha256'] = binding['inkSha256']


def recognition_observation(state):
    binding = recognition_binding(state)
    observation = state.get('_game', {}).get('_recognition')
    if not binding or not isinstance(observation, dict) or any(observation.get(key) != value for key, value in binding.items()):
        return None
    return {'modelVersion': observation.get('modelVersion'), 'candidates': deepcopy(observation.get('candidates', []))}


def _trivia_reveal(state, now):
    game = state['_game']
    _, _, correct = TRIVIA[game['order'][state['round'] - 1]]
    correct_ids = []
    for player in _active(state):
        answer = game['answers'].get(player['id'])
        if answer and answer['answer'] == correct:
            # A bounded speed bonus rewards prompt answers without making latency
            # dominate the base score; scores are server-computed.
            bonus = max(0, min(20, state['settings']['roundSeconds'] - (answer['at'] - state['phaseStartedAt'])))
            player['score'] += 100 + bonus
            correct_ids.append(player['id'])
    game['result'] = {'correctIds': correct_ids, 'text': str(len(correct_ids)) + ' correct answer(s).'}
    _phase(state, 'reveal', now, 6)
    _emit(state, 'Answer: ' + TRIVIA[game['order'][state['round'] - 1]][1][correct] + '.', now)


def _hand_reveal(state, now):
    game = state['_game']
    players = _active(state)
    left, right = players[0], players[1]
    a, b = game['choices'].get(left['id']), game['choices'].get(right['id'])
    winner = None
    if a != b:
        winner = left if a and (not b or (a, b) in {('rock', 'scissors'), ('paper', 'rock'), ('scissors', 'paper')}) else right
    if winner:
        winner['score'] += 1
    game['result'] = {'winnerId': winner['id'] if winner else None,
                      'text': winner['name'] + ' wins this hand.' if winner else 'A tie. Try another hand!'}
    _phase(state, 'reveal', now, 5)
    _emit(state, game['result']['text'], now)
    # A best-of-five match ends at three wins, with a bounded tie fallback.
    if winner and winner['score'] >= 3:
        _finish(state, winner['id'], winner['name'] + ' wins the duel!', now)
    elif state['round'] >= 30:
        _finish(state, _leaders(state), 'The duel reached its hand limit. Highest score wins; tied scores share the result.', now)


def _sketch_reveal(state, now):
    prompt = PROMPTS[state['_game']['order'][state['round'] - 1]][0]
    _phase(state, 'reveal', now, 6)
    _emit(state, 'The drawing was: ' + prompt + '.', now)


def _next_round(state, now):
    if state['kind'] in {'trivia', 'sketch-guess'} and state['round'] >= state['settings']['rounds']:
        _finish(state, _leaders(state), 'The game is complete. Highest score wins; tied scores share the result.', now)
        return
    state['round'] += 1
    game = state['_game']
    if state['kind'] == 'trivia':
        game.update(answers={}, result=None)
        _phase(state, 'question', now, state['settings']['roundSeconds'])
    elif state['kind'] == 'sketch-guess':
        game.update(strokes=[], guessedIds=[], lastStrokeAt={}, clearCount=0,
                    drawingEpoch=0, drawingAckIds=[], drawingRate={},
                    artistId=_active(state)[(state['round'] - 1) % len(_active(state))]['id'])
        _phase(state, 'draw', now, state['settings']['roundSeconds'])
    elif state['kind'] == 'hand-duel':
        game.update(choices={}, result=None)
        _phase(state, 'choose', now, state['settings']['roundSeconds'])
    else:
        fail('There is no next round.', 409)


def _board_winner(board, row, col, player_id):
    for dr, dc in [(0, 1), (1, 0), (1, 1), (1, -1)]:
        cells = [(row, col)]
        for direction in [-1, 1]:
            rr, cc = row + dr * direction, col + dc * direction
            while 0 <= rr < 6 and 0 <= cc < 7 and board[rr][cc] == player_id:
                cells.append((rr, cc))
                rr += dr * direction
                cc += dc * direction
        if len(cells) >= 4:
            return [list(cell) for cell in cells]
    return []


def _start_ship(state, now):
    players = _active(state)
    roles = _shuffle(['impostor'] * (2 if len(players) >= 8 else 1) + ['crew'] * (len(players) - (2 if len(players) >= 8 else 1)))
    game = {'roles': {}, 'positions': {}, 'tasks': {}, 'bodies': [], 'sabotage': None,
            'taskTotal': 0, 'votes': {}, 'readyIds': [], 'reportedId': None, 'meetingCallerId': None,
            'lastMoveAt': {}, 'lastTaskAt': {}, 'tagReadyAt': {}, 'sabotageReadyAt': {}, 'emergencies': {}}
    for index, (player, role) in enumerate(zip(players, roles)):
        player_id = player['id']
        game['roles'][player_id] = role
        game['positions'][player_id] = 'bridge'
        game['tagReadyAt'][player_id] = now + 15
        game['sabotageReadyAt'][player_id] = now + 15
        game['emergencies'][player_id] = True
        tasks = []
        for number in range(3):
            tasks.append({'id': 't' + str(number + 1), 'room': STATIONS[(index + number) % len(STATIONS)],
                          'label': ['Calibrate panel', 'Restore power', 'Align signal'][number],
                          'sequence': [secrets.choice(SYMBOLS) for _ in range(3)], 'progress': 0, 'complete': False})
        game['tasks'][player_id] = tasks
        if role == 'crew':
            game['taskTotal'] += len(tasks)
    state['_game'] = game
    _phase(state, 'roaming', now)


def _ship_tasks(state):
    game = state['_game']
    return sum(task['complete'] for player_id, tasks in game['tasks'].items()
               if game['roles'][player_id] == 'crew' and not _player(state, player_id).get('left') for task in tasks)


def _ship_winner(state, now):
    game = state['_game']
    living = _living(state)
    impostors = sum(game['roles'][player['id']] == 'impostor' for player in living)
    crew = len(living) - impostors
    if not impostors:
        winner, text = 'crew', 'The crew wins: every impostor is out.'
    elif impostors >= crew:
        winner, text = 'impostor', 'The impostors win: they now equal or outnumber the living crew.'
    elif game['taskTotal'] and _ship_tasks(state) >= game['taskTotal']:
        winner, text = 'crew', 'The crew wins: all ship tasks are complete.'
    else:
        return False
    for player in _active(state):
        if game['roles'][player['id']] == winner:
            player['score'] += 500
    _finish(state, winner, text, now)
    return True


def _ship_meeting(state, caller_id, reported_id, now):
    game = state['_game']
    game.update(votes={}, readyIds=[], meetingCallerId=caller_id, reportedId=reported_id, sabotage=None)
    # Bodies already reported vanish. Hidden player roles remain private.
    game['bodies'] = []
    _phase(state, 'discussion', now, state['settings']['roundSeconds'])
    _emit(state, _player(state, caller_id)['name'] + (' reported a body.' if reported_id else ' called an emergency meeting.'), now)


def _ship_vote(state, now):
    game = state['_game']
    eligible = {player['id'] for player in _living(state)}
    counts = Counter(target for actor, target in game['votes'].items() if actor in eligible and (target == 'skip' or target in eligible))
    top = max(counts.values(), default=0)
    winners = [target for target, count in counts.items() if count == top]
    target_id = winners[0] if len(winners) == 1 and winners[0] != 'skip' else None
    if target_id:
        target = _player(state, target_id)
        target['alive'] = False
        _emit(state, target['name'] + ' was ejected. Their role stays secret until the game ends.', now)
    else:
        _emit(state, 'The vote was tied or skipped. Nobody was ejected.', now)
    game.update(votes={}, readyIds=[], meetingCallerId=None, reportedId=None)
    for player in _active(state):
        if game['roles'][player['id']] == 'impostor':
            game['tagReadyAt'][player['id']] = now + 15
            game['sabotageReadyAt'][player['id']] = now + 15
    if not _ship_winner(state, now):
        _phase(state, 'roaming', now)


def reconcile(state, now=None):
    """Advance at most one expired phase; successful simultaneous inputs resolve immediately."""
    now = _now(now)
    state = deepcopy(state)
    if state['status'] != 'playing':
        return state
    kind, phase = state['kind'], state['phase']
    game = state['_game']
    if kind == 'starship-suspects':
        if phase == 'roaming' and game['sabotage'] and now >= game['sabotage']['deadlineAt']:
            for player in _active(state):
                if game['roles'][player['id']] == 'impostor':
                    player['score'] += 500
            _finish(state, 'impostor', 'The impostors win: the reactor countdown reached zero.', now)
        elif state['deadlineAt'] and now >= state['deadlineAt']:
            if phase == 'discussion':
                game['votes'] = {}
                _phase(state, 'voting', now, state['settings']['roundSeconds'])
            elif phase == 'voting':
                _ship_vote(state, now)
    elif state['deadlineAt'] and now >= state['deadlineAt']:
        if phase == 'reveal':
            _next_round(state, now)
        elif kind == 'trivia':
            _trivia_reveal(state, now)
        elif kind == 'sketch-guess':
            _sketch_reveal(state, now)
        elif kind == 'hand-duel':
            _hand_reveal(state, now)
        elif kind == 'drop-four':
            winner = next(player for player in _active(state) if player['id'] != game['turnId'])
            winner['score'] += 1
            game['result'] = {'winnerId': winner['id'], 'text': winner['name'] + ' wins after the other turn timed out.'}
            _finish(state, winner['id'], game['result']['text'], now)
    return state


def tick(state, now=None):
    """Advance bounded computer turns, only when a real seat requests the room.

    Policies receive the same allowlisted view as their own seat, never the
    private room. Their actions pass through the normal engine validators.
    The adapter persists this transition with its existing conditional write.
    """
    now = _now(now)
    state = reconcile(state, now)
    if state['status'] != 'playing' or not any(not player.get('isAI') for player in _active(state)):
        return state
    runtime = state.get('_ai', {})
    if not runtime:
        return state
    seats = []
    for player in _active(state):
        if player.get('isAI') is not True or player['id'] not in runtime:
            continue
        agent = runtime[player['id']]
        if agent.get('phaseId') != state['phaseId']:
            agent.update(phaseId=state['phaseId'], nextAt=max(now + 2, agent.get('nextAt', 0)))
        if now >= agent.get('nextAt', now + 2):
            seats.append(player)
    # Oldest overdue seat first prevents starvation when a throttled tab polls
    # more slowly than the think interval. Initialize every seat's phase before
    # applying the per-request work budget.
    seats.sort(key=lambda player: (runtime[player['id']]['nextAt'], player['id']))
    for player in seats[:AI_ACTIONS_PER_TICK]:
        agent = runtime[player['id']]
        phase = state['phaseId']
        view = deepcopy(project(state, player['id'], now))
        if state['kind'] == 'sketch-guess' and player['id'] != _artist(state):
            observation = recognition_observation(state)
            if observation: view['game']['recognition'] = observation
        action, memory = ai_rules().decide(view, deepcopy(agent.get('memory', {})), now)
        if not isinstance(memory, dict) or len(json.dumps(memory, ensure_ascii=True, allow_nan=False, separators=(',', ':'))) > AI_MEMORY_BYTES:
            memory = {}
        agent.update(memory=memory, nextAt=now + 2 + secrets.randbelow(3))
        if action is not None:
            try:
                state = apply_action(state, player['id'], {'phaseId': state['phaseId'], **action}, now=now)
            except PartyError:
                # A policy suggestion can become stale after an earlier bot in
                # this same tick. It never bypasses game authority or retries in
                # a catch-up loop.
                pass
        state['_ai'] = runtime
        if state['phaseId'] != phase or state['status'] != 'playing':
            break
    return state


def _leave(state, actor, now):
    if actor['id'] == state['hostId']:
        fail('The creator should close the room instead of leaving.', 409)
    was_artist = state['kind'] == 'sketch-guess' and actor['id'] == _artist(state)
    actor.update(left=True, alive=False)
    _emit(state, actor['name'] + ' left the room.', now)
    if state['status'] != 'playing':
        return
    if state['kind'] == 'starship-suspects':
        game = state['_game']
        if game['roles'][actor['id']] == 'crew':
            game['taskTotal'] -= len(game['tasks'][actor['id']])
        game['votes'].pop(actor['id'], None)
        game['readyIds'] = [player_id for player_id in game['readyIds'] if player_id != actor['id']]
        if not _ship_winner(state, now):
            living_ids = {player['id'] for player in _living(state)}
            if state['phase'] == 'discussion' and living_ids <= set(game['readyIds']):
                _phase(state, 'voting', now, state['settings']['roundSeconds'])
            elif state['phase'] == 'voting' and living_ids <= set(game['votes']):
                _ship_vote(state, now)
    elif len(_active(state)) < 2:
        winner = _active(state)[0]
        _finish(state, winner['id'], winner['name'] + ' wins because the other player left.', now)
    elif state['kind'] == 'sketch-guess' and state['phase'] == 'draw':
        if was_artist or all(player['id'] in state['_game']['guessedIds'] for player in _active(state) if player['id'] != _artist(state)):
            _sketch_reveal(state, now)
    elif state['kind'] == 'trivia' and state['phase'] == 'question':
        if all(player['id'] in state['_game']['answers'] for player in _active(state)):
            _trivia_reveal(state, now)


FIELDS = {
    'start': set(), 'close': set(), 'restart': set(), 'leave': set(), 'advance': set(),
    'add-ai': set(), 'fill-ai': set(),
    'kick': {'targetId'}, 'settings': {'settings'}, 'chat': {'text'},
    'choose': {'choice'}, 'drop': {'column'}, 'answer': {'answer'}, 'guess': {'text'},
    'stroke': {'color', 'width', 'points'},
    'drawing-batch': {'drawingEpoch', 'segments'}, 'clear-drawing': {'drawingEpoch'},
    'move': {'room'}, 'task': {'taskId', 'step'}, 'tag': {'targetId'}, 'sabotage': set(),
    'repair': {'step'}, 'report': {'targetId'}, 'emergency': set(), 'ready': set(), 'vote': {'targetId'},
}


def apply_action(state, actor_id, action, now=None):
    """Apply one flat authenticated action. Unknown fields fail closed."""
    now = _now(now)
    state = reconcile(state, now)
    actor = _player(state, _identifier(actor_id))
    if actor.get('left'):
        fail('This seat has left the room.', 403)
    if not isinstance(action, dict) or not isinstance(action.get('type'), str):
        fail('Choose an available party action.')
    kind = action['type']
    if kind not in FIELDS or set(action) - FIELDS[kind] - {'type', 'phaseId', 'requestId'}:
        fail('Unsupported party action fields.')
    if 'phaseId' in action and (type(action['phaseId']) is not int or action['phaseId'] != state['phaseId']):
        fail('The phase changed. Refresh the room and choose again.', 409)
    if state['status'] == 'closed':
        fail('This room is closed.', 409)
    if kind == 'close':
        _host(state, actor_id)
        state['status'] = 'closed'
        state['_game'] = {}
        state.pop('_ai', None)
        _phase(state, 'closed', now)
        _emit(state, 'The creator closed this room.', now)
        return state
    if kind == 'restart':
        _host(state, actor_id)
        if state['status'] != 'finished':
            fail('Finish the game before setting up a rematch.', 409)
        state['status'] = 'lobby'
        state['players'] = _active(state)
        for player in state['players']:
            player.update(score=0, alive=True)
        state.update(round=0, winner=None, _game={}, chat=[], events=[], _messageTimes={})
        state.pop('_ai', None)
        _phase(state, 'lobby', now)
        return state
    if kind == 'leave':
        _leave(state, actor, now)
        return state
    if kind in {'start', 'settings', 'kick', 'add-ai', 'fill-ai'}:
        _host(state, actor_id)
        if state['status'] != 'lobby':
            fail('This control is only available in the lobby.', 409)
        if kind == 'start':
            _start(state, now)
        elif kind in {'add-ai', 'fill-ai'}:
            needed = 1 if kind == 'add-ai' else max(0, GAMES[state['kind']]['minPlayers'] - len(_active(state)))
            if not needed:
                fail('There are already enough players to start.', 409)
            if len(_active(state)) + needed > state['settings']['maxPlayers']:
                fail('This room is full.', 409)
            state['players'] = _active(state)
            for _ in range(needed):
                names = {player['name'].casefold() for player in state['players']}
                number = next(number for number in range(1, 50) if ('AI Player ' + str(number)).casefold() not in names)
                occupied = {player['id'] for player in state['players']}
                player_id = None
                for _ in range(8):
                    candidate = str(uuid.uuid4())
                    if candidate not in occupied:
                        player_id = candidate
                        break
                if player_id is None:
                    fail('A computer seat could not be reserved. Try again.', 503)
                state['players'].append({'id': player_id, 'name': 'AI Player ' + str(number), 'avatar': 'robot',
                                         'isAI': True, 'alive': True, 'left': False, 'score': 0})
                _emit(state, 'AI Player ' + str(number) + ' joined as a computer opponent.', now)
        elif kind == 'settings':
            updated = validate_settings(state['kind'], action.get('settings'), state['settings'])
            if updated['maxPlayers'] < len(_active(state)):
                fail('The player limit must fit everyone in this room.', 409)
            state['settings'] = updated
        elif kind == 'kick':
            target = _player(state, _identifier(action.get('targetId')))
            if target['id'] == state['hostId']:
                fail('The creator cannot remove their own seat.')
            state['players'] = [player for player in state['players'] if player['id'] != target['id']]
            state['_messageTimes'].pop(target['id'], None)
            state.get('_ai', {}).pop(target['id'], None)
            _emit(state, target['name'] + ' was removed from the lobby.', now)
        return state
    if kind == 'chat':
        if state['kind'] == 'starship-suspects' and state['status'] == 'playing' and (not actor['alive'] or state['phase'] not in {'discussion', 'voting'}):
            fail('Living players can chat during meetings.', 403)
        _chat(state, actor, action.get('text'), now)
        return state
    if state['status'] != 'playing':
        fail('Start a game before making that choice.', 409)
    if kind == 'advance':
        _host(state, actor_id)
        if state['phase'] != 'reveal':
            fail('The next round opens after the answer is revealed.', 409)
        _next_round(state, now)
        return state
    game_kind = state['kind']
    if game_kind == 'hand-duel':
        if kind != 'choose' or state['phase'] != 'choose':
            fail('Choose a hand while this round is open.', 409)
        choice = action.get('choice')
        if not isinstance(choice, str) or choice not in {'rock', 'paper', 'scissors'}:
            fail('Choose rock, paper or scissors.')
        game = state['_game']
        if actor_id in game['choices']:
            fail('Your hand is already locked in.', 409)
        game['choices'][actor_id] = choice
        if len(game['choices']) == len(_active(state)):
            _hand_reveal(state, now)
    elif game_kind == 'drop-four':
        _drop_action(state, actor, kind, action, now)
    elif game_kind == 'trivia':
        if kind != 'answer' or state['phase'] != 'question':
            fail('Answer while the question is open.', 409)
        answer = action.get('answer')
        if type(answer) is not int or not 0 <= answer <= 3:
            fail('Choose one of the four answers.')
        game = state['_game']
        if actor_id in game['answers']:
            fail('Your answer is already locked in.', 409)
        game['answers'][actor_id] = {'answer': answer, 'at': now}
        if all(player['id'] in game['answers'] for player in _active(state)):
            _trivia_reveal(state, now)
    elif game_kind == 'sketch-guess':
        _sketch_action(state, actor, kind, action, now)
    elif game_kind == 'starship-suspects':
        _ship_action(state, actor, kind, action, now)
    return state


def _drop_action(state, actor, kind, action, now):
    if kind != 'drop' or state['phase'] != 'turn':
        fail('Drop a disc during your turn.', 409)
    game = state['_game']
    if actor['id'] != game['turnId']:
        fail('Wait for your turn.', 403)
    column = action.get('column')
    if type(column) is not int or not 0 <= column <= 6:
        fail('Choose a column from one to seven.')
    row = next((row for row in range(5, -1, -1) if game['board'][row][column] is None), None)
    if row is None:
        fail('That column is full. Choose another.', 409)
    game['board'][row][column] = actor['id']
    cells = _board_winner(game['board'], row, column, actor['id'])
    if cells:
        actor['score'] += 1
        game.update(winningCells=cells, result={'winnerId': actor['id'], 'text': actor['name'] + ' connected four!'})
        _finish(state, actor['id'], game['result']['text'], now)
    elif all(cell is not None for board_row in game['board'] for cell in board_row):
        game['result'] = {'winnerId': None, 'text': 'The board is full. A draw!'}
        _finish(state, 'draw', game['result']['text'], now)
    else:
        game['turnId'] = next(player['id'] for player in _active(state) if player['id'] != actor['id'])
        _phase(state, 'turn', now, state['settings']['roundSeconds'])


def _normalized(value):
    return ''.join(char for char in unicodedata.normalize('NFKD', value).casefold() if char.isalnum())


def _drawing_segment(segment, actor_id, identifier):
    if not isinstance(segment, dict) or set(segment) - {'id', 'color', 'width', 'points'}:
        fail('Unsupported drawing segment fields.')
    color, width, points = segment.get('color'), segment.get('width'), segment.get('points')
    if not isinstance(color, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', color):
        fail('Choose a drawing color.')
    if type(width) not in (int, float) or not 1 <= width <= 12:
        fail('Choose a pen width from one to twelve.')
    if not isinstance(points, list) or not 1 <= len(points) <= DRAWING_SEGMENT_POINTS:
        fail('A drawing segment needs one to 120 points.')
    clean = []
    for point in points:
        if not isinstance(point, list) or len(point) != 2 or any(type(value) not in (int, float) or not 0 <= value <= 1 for value in point):
            fail('Drawing points must stay on the canvas.')
        point = [round(float(value), 4) for value in point]
        if not clean or point != clean[-1]:
            clean.append(point)
    return {'id': identifier, 'playerId': actor_id, 'color': color.lower(), 'width': round(float(width), 2), 'points': clean}


def _compact_drawing(game):
    # Preserve both endpoints when reducing older polylines, including the shared
    # endpoint between streamed chunks. Recent ink keeps its original detail.
    strokes = game['strokes'][-DRAWING_STROKES:]
    total = sum(len(stroke['points']) for stroke in strokes)
    encoded = len(json.dumps(strokes, separators=(',', ':'), ensure_ascii=True))
    while total > DRAWING_POINTS or encoded > DRAWING_BYTES:
        for stroke in strokes:
            points = stroke['points']
            if len(points) <= 2:
                continue
            before = len(json.dumps(points, separators=(',', ':')))
            reduced = points[::2]
            if reduced[-1] != points[-1]:
                reduced.append(points[-1])
            stroke['points'] = reduced
            total -= len(points) - len(reduced)
            encoded -= before - len(json.dumps(reduced, separators=(',', ':')))
            if total <= DRAWING_POINTS and encoded <= DRAWING_BYTES:
                break
    game['strokes'] = strokes


def _sketch_action(state, actor, kind, action, now):
    if state['phase'] != 'draw':
        fail('The drawing turn has ended.', 409)
    game = state['_game']
    artist_id = _artist(state)
    if kind in {'stroke', 'drawing-batch', 'clear-drawing'}:
        if actor['id'] != artist_id:
            fail('Only the current artist can draw.', 403)
        epoch = game.get('drawingEpoch', 0)
        if kind == 'drawing-batch' or 'drawingEpoch' in action:
            if type(action.get('drawingEpoch')) is not int or action['drawingEpoch'] < 0:
                fail('Use the current drawing canvas.')
            if action['drawingEpoch'] != epoch:
                fail('The canvas was cleared. Discard the previous drawing queue.', 409)
        if kind == 'clear-drawing':
            rate = game.get('drawingRate', {})
            count = rate.get('count', 0) if rate.get('second') == now else 0
            if count >= 4:
                fail('Drawing is syncing. Retry the queued batch shortly.', 429)
            game['drawingRate'] = {'second': now, 'count': count + 1}
            game['clearCount'] += 1
            game.update(strokes=[], drawingEpoch=epoch + 1, drawingAckIds=[])
            game.pop('_recognitionJob', None)
            _refresh_recognition_ink(state)
            return
        if kind == 'drawing-batch':
            segments = action.get('segments')
            if not isinstance(segments, list) or not 1 <= len(segments) <= DRAWING_BATCH_SEGMENTS:
                fail('Send one to six drawing segments at a time.')
            identifiers = [_identifier(segment.get('id')) if isinstance(segment, dict) else _identifier(None) for segment in segments]
            seen = {stroke['id'] for stroke in game['strokes']} | set(game.get('drawingAckIds', []))
            if len(set(identifiers)) != len(identifiers) or seen.intersection(identifiers):
                fail('A drawing segment identifier was already used.', 409)
            clean = [_drawing_segment(segment, actor['id'], identifier) for segment, identifier in zip(segments, identifiers)]
        else:
            # Legacy clients still send a complete stroke. They share the same
            # bounded canvas but no longer wait one second between strokes.
            state['_sequence'] += 1
            identifiers = []
            clean = [_drawing_segment({key: action.get(key) for key in ('color', 'width', 'points')}, actor['id'], 's' + str(state['_sequence']))]
        rate = game.get('drawingRate', {})
        count = rate.get('count', 0) if rate.get('second') == now else 0
        if count >= 4:
            fail('Drawing is syncing. Retry the queued batch shortly.', 429)
        game['drawingRate'] = {'second': now, 'count': count + 1}
        game['strokes'].extend(clean)
        game['drawingAckIds'] = [*game.get('drawingAckIds', []), *identifiers][-DRAWING_ACK_IDS:]
        _compact_drawing(game)
        _refresh_recognition_ink(state)
    elif kind == 'guess':
        if actor['id'] == artist_id:
            fail('The artist cannot guess their own prompt.', 403)
        if actor['id'] in game['guessedIds']:
            fail('You already guessed this drawing.', 409)
        text = _text(action.get('text'), 80, 'Guess')
        prompt, aliases = PROMPTS[game['order'][state['round'] - 1]]
        if _normalized(text) in {_normalized(value) for value in [prompt, *aliases]}:
            # Validate/rate-limit through chat without leaking the secret answer.
            _chat(state, actor, 'Guessed the drawing!', now)
            game['guessedIds'].append(actor['id'])
            actor['score'] += 100
            _player(state, artist_id)['score'] += 30
            if all(player['id'] in game['guessedIds'] for player in _active(state) if player['id'] != artist_id):
                _sketch_reveal(state, now)
        else:
            _chat(state, actor, text, now)
    else:
        fail('Choose a drawing or guessing action.', 409)


def _ship_action(state, actor, kind, action, now):
    game = state['_game']
    actor_id = actor['id']
    role = game['roles'][actor_id]
    phase = state['phase']
    room = game['positions'][actor_id]
    if kind in {'ready', 'vote'}:
        if not actor['alive']:
            fail('Only living players can take part in a meeting.', 403)
        if kind == 'ready':
            if phase != 'discussion':
                fail('Ready is available during discussion.', 409)
            if actor_id not in game['readyIds']:
                game['readyIds'].append(actor_id)
            if len(game['readyIds']) == len(_living(state)):
                _phase(state, 'voting', now, state['settings']['roundSeconds'])
        else:
            if phase != 'voting':
                fail('Voting is not open.', 409)
            target_id = action.get('targetId')
            if target_id != 'skip':
                target = _player(state, _identifier(target_id))
                if not target['alive'] or target.get('left'):
                    fail('Vote for a living player or skip.')
            if actor_id in game['votes']:
                fail('Your vote is already locked in.', 409)
            game['votes'][actor_id] = target_id
            if len(game['votes']) == len(_living(state)):
                _ship_vote(state, now)
        return
    if phase != 'roaming':
        fail('Resume ship activity after the meeting.', 409)
    if kind == 'move':
        target_room = action.get('room')
        current = next(item for item in ROOMS if item['id'] == room)
        if not isinstance(target_room, str) or target_room not in current['neighbors']:
            fail('Choose a connected room.')
        if now < game['lastMoveAt'].get(actor_id, -10) + 1:
            fail('Wait a moment before moving again.', 429)
        game['positions'][actor_id] = target_room
        game['lastMoveAt'][actor_id] = now
    elif kind == 'task':
        task_id = action.get('taskId')
        if not isinstance(task_id, str):
            fail('Choose one of your tasks.')
        task = next((task for task in game['tasks'][actor_id] if task['id'] == task_id), None)
        if not task or task['room'] != room or task['complete']:
            fail('Choose an unfinished task in this room.', 409)
        if now < game['lastTaskAt'].get(actor_id, -10) + 1:
            fail('Wait a moment before the next task step.', 429)
        if action.get('step') != task['sequence'][task['progress']]:
            fail('Follow the symbols in order.')
        task['progress'] += 1
        game['lastTaskAt'][actor_id] = now
        if task['progress'] == len(task['sequence']):
            task['complete'] = True
            if role == 'crew':
                actor['score'] += 50
                _ship_winner(state, now)
    elif kind == 'tag':
        if role != 'impostor' or not actor['alive']:
            fail('Only living impostors can tag a crewmate.', 403)
        if now < game['tagReadyAt'][actor_id]:
            fail('Your tag is still cooling down.', 409)
        target = _player(state, _identifier(action.get('targetId')))
        if not target['alive'] or target.get('left') or game['roles'][target['id']] != 'crew' or game['positions'][target['id']] != room:
            fail('Choose a living crewmate in your room.')
        target['alive'] = False
        game['bodies'].append({'playerId': target['id'], 'room': room})
        game['tagReadyAt'][actor_id] = now + 15
        actor['score'] += 100
        _ship_winner(state, now)
    elif kind == 'sabotage':
        if role != 'impostor' or not actor['alive']:
            fail('Only living impostors can sabotage.', 403)
        if game['sabotage'] or now < game['sabotageReadyAt'][actor_id]:
            fail('Sabotage is not ready yet.', 409)
        game['sabotage'] = {'room': 'reactor', 'deadlineAt': now + 60, 'progress': 0}
        for player in _active(state):
            if game['roles'][player['id']] == 'impostor':
                game['sabotageReadyAt'][player['id']] = now + 60
        _emit(state, 'Reactor alert! Complete three repairs in the reactor before the timer ends.', now)
    elif kind == 'repair':
        if not actor['alive'] or room != 'reactor' or not game['sabotage']:
            fail('Living players can repair an active alert in the reactor.', 409)
        if now < game['lastTaskAt'].get(actor_id, -10) + 1:
            fail('Wait a moment before the next repair.', 429)
        if type(action.get('step')) is not int or action['step'] != game['sabotage']['progress']:
            fail('The repair changed. Use the current step.', 409)
        game['sabotage']['progress'] += 1
        game['lastTaskAt'][actor_id] = now
        if game['sabotage']['progress'] == 3:
            game['sabotage'] = None
            actor['score'] += 25
            _emit(state, 'The reactor is stable again.', now)
    elif kind == 'report':
        if not actor['alive']:
            fail('Only living players can report a body.', 403)
        target_id = action.get('targetId')
        if not isinstance(target_id, str) or not any(body['playerId'] == target_id and body['room'] == room for body in game['bodies']):
            fail('Report a body in your current room.')
        _ship_meeting(state, actor_id, target_id, now)
    elif kind == 'emergency':
        if not actor['alive'] or not game['emergencies'][actor_id]:
            fail('Each living player has one emergency meeting.', 409)
        if game['sabotage']:
            fail('Repair the reactor before calling an emergency meeting.', 409)
        game['emergencies'][actor_id] = False
        _ship_meeting(state, actor_id, None, now)
    else:
        fail('Choose an available ship action.', 409)


def project(state, viewer_id, now=None):
    """An allowlisted per-seat view: roles, answers and prompts are never shared early."""
    _now(now)
    viewer = _player(state, _identifier(viewer_id))
    result = {key: deepcopy(state[key]) for key in ('version', 'kind', 'hostId', 'status', 'phase', 'phaseId', 'round',
                                                   'settings', 'createdAt', 'deadlineAt', 'winner', 'events', 'chat')}
    result['id'] = state.get('roomId') or state['hostId']
    result['roomId'] = result['id']
    result['title'] = GAMES[state['kind']]['title']
    result['players'] = [{key: deepcopy(player[key]) for key in ('id', 'name', 'avatar', 'score', 'alive', 'left')}
                         for player in state['players']]
    for source, player in zip(state['players'], result['players']):
        if source.get('isAI') is True:
            player['isAI'] = True
    result['self'] = {'id': viewer_id, 'isHost': viewer_id == state['hostId'],
                      'alive': viewer['alive'], 'left': viewer.get('left', False)}
    result['game'] = {}
    if state['status'] in {'lobby', 'closed'}:
        return result
    kind, game, public, private = state['kind'], state['_game'], result['game'], result['self']
    reveal = state['phase'] in {'reveal', 'finished'}
    if kind == 'hand-duel':
        public.update(selectedIds=sorted(game['choices']), choices=deepcopy(game['choices']) if reveal else {},
                      result=deepcopy(game['result']), targetWins=3)
        private['choice'] = game['choices'].get(viewer_id)
    elif kind == 'drop-four':
        public.update({key: deepcopy(game[key]) for key in ('board', 'turnId', 'winningCells', 'result')})
    elif kind == 'trivia':
        text, options, correct = TRIVIA[game['order'][state['round'] - 1]]
        public.update(question={'id': 'q' + str(state['round']), 'text': text, 'options': deepcopy(options)},
                      answeredIds=sorted(game['answers']), result=deepcopy(game['result']))
        if reveal:
            public['correctIndex'] = correct
        private['answer'] = game['answers'].get(viewer_id, {}).get('answer')
    elif kind == 'sketch-guess':
        prompt = PROMPTS[game['order'][state['round'] - 1]][0]
        public.update(artistId=_artist(state), strokes=deepcopy(game['strokes']), guessedIds=list(game['guessedIds']),
                      drawingEpoch=game.get('drawingEpoch', 0), drawingAckIds=list(game.get('drawingAckIds', [])))
        binding = recognition_binding(state)
        if binding: public['inkSha256'] = binding['inkSha256']
        if reveal:
            public['prompt'] = prompt
        if viewer_id == _artist(state):
            private['prompt'] = prompt
    elif kind == 'starship-suspects':
        # Per-player task/tag points reveal team membership. Keep them private
        # until the legitimate end-of-game role reveal.
        if state['status'] != 'finished':
            for player in result['players']:
                player['score'] = 0
        private['score'] = viewer['score']
        public.update(rooms=deepcopy(ROOMS), positions=[{'id': player['id'], 'room': game['positions'][player['id']], 'alive': player['alive']}
                                                     for player in _active(state)],
                      bodies=deepcopy(game['bodies']), tasksCompleted=_ship_tasks(state), tasksTotal=game['taskTotal'],
                      sabotage=deepcopy(game['sabotage']), reportedId=game['reportedId'], meetingCallerId=game['meetingCallerId'],
                      votedIds=sorted(game['votes']), readyIds=deepcopy(game['readyIds']))
        private.update(role=game['roles'][viewer_id], room=game['positions'][viewer_id], tasks=deepcopy(game['tasks'][viewer_id]),
                       moveReadyAt=game['lastMoveAt'].get(viewer_id, -10) + 1,
                       taskReadyAt=game['lastTaskAt'].get(viewer_id, -10) + 1,
                       teammateIds=sorted(player_id for player_id, role in game['roles'].items() if role == 'impostor' and player_id != viewer_id) if game['roles'][viewer_id] == 'impostor' else [],
                       tagReadyAt=game['tagReadyAt'][viewer_id] if game['roles'][viewer_id] == 'impostor' else None,
                       sabotageReadyAt=game['sabotageReadyAt'][viewer_id] if game['roles'][viewer_id] == 'impostor' else None,
                       emergencyAvailable=game['emergencies'][viewer_id], vote=game['votes'].get(viewer_id))
        if state['status'] == 'finished':
            for player in result['players']:
                player['role'] = game['roles'][player['id']]
    return result
