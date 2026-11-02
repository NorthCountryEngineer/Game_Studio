"""Pure, server-authoritative Mafia rules and per-seat privacy projections.

Storage/authentication/idempotency live in the API adapter. All transitions copy
input state; callers persist the returned state with their own revision fence.
Timestamps are integer Unix seconds. API actions include a phaseId/requestId;
this module checks phaseId when present and otherwise takes an authenticated
actor ID. No client-supplied role, winner, points, narration or state is accepted.

Exports: new_room, add_player, apply_action, reconcile, project, validate_player,
validate_settings, AVATARS, MafiaError. The API adds its UUID as state.roomId.
"""
from collections import Counter
from copy import deepcopy
import re
import secrets
import time
import unicodedata

AVATARS = ('fox', 'bear', 'cat', 'dog', 'rabbit', 'panda', 'tiger', 'lion', 'frog', 'owl',
           'koala', 'unicorn', 'dragon', 'robot', 'alien', 'ghost', 'octopus', 'penguin', 'monkey', 'butterfly')
ROLES = ('mafia', 'detective', 'doctor', 'civilian')
PHASES = ('lobby', 'night', 'discussion', 'voting', 'finished', 'closed')
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
DEFAULT_SETTINGS = {'maxPlayers': 12, 'nightSeconds': 75, 'discussionSeconds': 90, 'votingSeconds': 45}
MAX_EVENTS = 100
MAX_CHAT = 80
MAX_MAFIA_CHAT = 40
MAX_CHECKS = 100


class MafiaError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message
        super().__init__(message)


def fail(message, status=400):
    raise MafiaError(status, message)


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


def validate_player(value):
    if not isinstance(value, dict) or set(value) != {'id', 'name', 'avatar'}:
        fail('Expected a player name and avatar.')
    if value['avatar'] not in AVATARS:
        fail('Choose an available avatar.')
    return {'id': _identifier(value['id']), 'name': _text(value['name'], 16, 'Player name'), 'avatar': value['avatar']}


def validate_settings(value=None, current=None):
    if value is None:
        value = {}
    if not isinstance(value, dict) or set(value) - set(DEFAULT_SETTINGS):
        fail('Unsupported Mafia room settings.')
    result = {**(current or DEFAULT_SETTINGS), **value}
    for field, low, high in [('maxPlayers', 5, 24), ('nightSeconds', 30, 300), ('discussionSeconds', 30, 300), ('votingSeconds', 30, 300)]:
        if type(result.get(field)) is not int or not low <= result[field] <= high:
            fail('Mafia room settings are outside their allowed range.')
    return result


def _player(state, actor_id):
    for player in state['players']:
        if player['id'] == actor_id:
            return player
    fail('Your seat is no longer in this room.', 403)


def _active(state):
    return [player for player in state['players'] if player['id'] != state['narratorId'] and not player.get('left')]


def _living(state):
    return [player for player in _active(state) if player['alive']]


def _is_narrator(state, actor_id):
    return state['narratorMode'] == 'human' and state['narratorId'] == actor_id


def _require_owner(state, actor_id):
    if state['ownerId'] != actor_id:
        fail('Only the room creator can do that.', 403)


def _require_narrator(state, actor_id):
    if not _is_narrator(state, actor_id):
        fail('Only the narrator can do that.', 403)


def _sequence(state):
    state['_sequence'] += 1
    return 'e' + str(state['_sequence'])


def _emit(state, kind, text, now):
    # AI writes only generic atmosphere. This factual suffix is always server-owned.
    narration_key = {'elimination': 'eliminated', 'no-elimination': 'protected' if state['phase'] == 'night' else 'tie',
                     'town-win': 'townWin', 'mafia-win': 'mafiaWin'}.get(kind, kind)
    prose = state.get('narration', {}).get(narration_key) if state['narratorMode'] == 'ai' else None
    if isinstance(prose, str) and 1 <= len(prose) <= 320 and not any(unicodedata.category(c) in {'Cc', 'Cs', 'Zl', 'Zp'} for c in prose):
        text = prose.strip() + ' ' + text
    state['events'].append({'id': _sequence(state), 'kind': kind, 'text': text, 'at': now, 'day': state['day']})
    state['events'] = state['events'][-MAX_EVENTS:]


def _set_phase(state, phase, now):
    state['phase'] = phase
    state['phaseId'] += 1
    state['phaseStartedAt'] = now
    duration = {'night': 'nightSeconds', 'discussion': 'discussionSeconds', 'voting': 'votingSeconds'}.get(phase)
    state['deadlineAt'] = now + state['settings'][duration] if duration else None
    state['ready'] = []
    if phase == 'night':
        state['nightActions'] = {}
        state['votes'] = {}
        _emit(state, 'night', 'Night ' + str(state['day']) + ': secret roles make their choices. Everyone else waits quietly.', now)
    elif phase == 'discussion':
        _emit(state, 'discussion', 'Day ' + str(state['day']) + ': discuss who you suspect. Living players can mark themselves ready for voting.', now)
    elif phase == 'voting':
        state['votes'] = {}
        _emit(state, 'voting', 'Voting is open. Each living player can choose a suspect or skip. A tied result eliminates nobody.', now)


def _check_winner(state, now):
    living = _living(state)
    mafia_count = sum(player['role'] == 'mafia' for player in living)
    town_count = len(living) - mafia_count
    if mafia_count == 0:
        winner = 'town'
    elif mafia_count >= town_count:
        winner = 'mafia'
    else:
        return False
    state['winner'] = winner
    _set_phase(state, 'finished', now)
    state['nightActions'] = {}
    state['votes'] = {}
    _emit(state, winner + '-win', 'The town wins: every Mafia member is out.' if winner == 'town' else 'The Mafia wins: its living members now equal or outnumber the town.', now)
    return True


def _required_night(state):
    return [player['id'] for player in _living(state) if player['role'] in {'mafia', 'doctor', 'detective'}]


def _phase_ready(state):
    if state['phase'] == 'night':
        required = _required_night(state)
        return all(player_id in state['nightActions'] for player_id in required)
    if state['phase'] == 'discussion':
        return all(player['id'] in state['ready'] for player in _living(state))
    if state['phase'] == 'voting':
        return all(player['id'] in state['votes'] for player in _living(state))
    return False


def _unique_winner(values):
    counts = Counter(values)
    if not counts:
        return None
    best = max(counts.values())
    winners = [value for value, count in counts.items() if count == best]
    return winners[0] if len(winners) == 1 else None


def _resolve_night(state, now):
    alive = {player['id']: player for player in _living(state)}
    actions = state['nightActions']
    targets = [actions[player_id] for player_id, player in alive.items() if player['role'] == 'mafia' and player_id in actions]
    target_id = _unique_winner(targets)
    protected = {actions[player_id] for player_id, player in alive.items() if player['role'] == 'doctor' and player_id in actions}
    # All actions occur together, including a detective's final investigation.
    for player_id, player in alive.items():
        if player['role'] == 'detective' and player_id in actions:
            subject = alive.get(actions[player_id])
            if subject:
                player['checks'].append({'day': state['day'], 'targetId': subject['id'], 'isMafia': subject['role'] == 'mafia'})
                player['checks'] = player['checks'][-MAX_CHECKS:]
    if target_id in alive and target_id not in protected:
        alive[target_id]['alive'] = False
        _emit(state, 'elimination', alive[target_id]['name'] + ' was eliminated during the night.', now)
    else:
        _emit(state, 'no-elimination', 'Nobody was eliminated during the night.', now)
    state['nightActions'] = {}
    if not _check_winner(state, now):
        _set_phase(state, 'discussion', now)


def _resolve_votes(state, now):
    living = {player['id']: player for player in _living(state)}
    choices = [target for player_id, target in state['votes'].items() if player_id in living and (target == 'skip' or target in living)]
    target_id = _unique_winner(choices)
    if target_id and target_id != 'skip':
        living[target_id]['alive'] = False
        _emit(state, 'elimination', living[target_id]['name'] + ' was voted out by the town.', now)
    else:
        _emit(state, 'no-elimination', 'The town did not eliminate anyone in this vote.', now)
    state['votes'] = {}
    if not _check_winner(state, now):
        state['day'] += 1
        _set_phase(state, 'night', now)


def _advance(state, now):
    if state['phase'] == 'night':
        _resolve_night(state, now)
    elif state['phase'] == 'discussion':
        _set_phase(state, 'voting', now)
    elif state['phase'] == 'voting':
        _resolve_votes(state, now)
    else:
        fail('This room has no phase to advance.', 409)


def new_room(owner, narrator_mode='human', now=None, settings=None):
    now = _now(now)
    owner = validate_player(owner)
    if not isinstance(narrator_mode, str) or narrator_mode not in {'human', 'ai'}:
        fail('Choose a human or AI narrator.')
    state = {
        'version': 1, 'roomId': None, 'phase': 'lobby', 'phaseId': 0, 'day': 0,
        'ownerId': owner['id'], 'narratorId': owner['id'] if narrator_mode == 'human' else None,
        'narratorMode': narrator_mode, 'settings': validate_settings(settings),
        'players': [{**owner, 'role': None, 'alive': True, 'checks': []}],
        'createdAt': now, 'phaseStartedAt': now, 'deadlineAt': None, 'winner': None,
        'nightActions': {}, 'votes': {}, 'ready': [], 'events': [], 'chat': [], 'mafiaChat': [],
        '_sequence': 0, '_messageTimes': {},
    }
    _emit(state, 'created', owner['name'] + ' opened the room. Choose an avatar and invite your group.', now)
    return state


def add_player(state, player, now=None):
    now = _now(now)
    player = validate_player(player)
    state = deepcopy(state)
    if state['phase'] != 'lobby':
        fail('The round has already started. Ask the creator for a new room.', 409)
    if any(item['id'] == player['id'] for item in state['players']):
        fail('That seat is already in this room.', 409)
    if any(item['name'].casefold() == player['name'].casefold() for item in state['players']):
        fail('Choose a different name so everyone can tell you apart.', 409)
    if len(_active(state)) >= state['settings']['maxPlayers']:
        fail('This room is full.', 409)
    state['players'].append({**player, 'role': None, 'alive': True, 'checks': []})
    _emit(state, 'joined', player['name'] + ' joined the room.', now)
    return state


def reconcile(state, now=None):
    """Advance at most one AI phase on a poll. Human phase control stays human."""
    now = _now(now)
    state = deepcopy(state)
    if state['narratorMode'] == 'ai' and state['phase'] in {'night', 'discussion', 'voting'}:
        if _phase_ready(state) or now >= state['deadlineAt']:
            _advance(state, now)
    return state


def _message(state, actor, text, channel, now):
    text = _text(text, 240, 'Message')
    times = [at for at in state['_messageTimes'].get(actor['id'], []) if at > now - 60]
    if len(times) >= 12:
        fail('Wait a moment before sending another message.', 429)
    times.append(now)
    state['_messageTimes'][actor['id']] = times
    field, maximum = ('mafiaChat', MAX_MAFIA_CHAT) if channel == 'mafia' else ('chat', MAX_CHAT)
    state[field].append({'id': _sequence(state), 'playerId': actor['id'], 'text': text, 'at': now, 'day': state['day']})
    state[field] = state[field][-maximum:]


def apply_action(state, actor_id, action, now=None):
    """Apply one authenticated, flat action; unknown fields/actions fail closed."""
    now = _now(now)
    state = deepcopy(state)
    actor = _player(state, _identifier(actor_id))
    if actor.get('left'):
        fail('This seat has left the room.', 403)
    if not isinstance(action, dict) or not isinstance(action.get('type'), str):
        fail('Choose an available room action.')
    kind = action['type']
    fields = {
        'start': set(), 'restart': set(), 'reassign-narrator': {'targetId'}, 'configure': {'settings', 'narratorMode'},
        'kick': {'targetId'}, 'close': set(), 'leave': set(), 'night-action': {'targetId'},
        'vote': {'targetId'}, 'ready': set(), 'advance': {'force'}, 'chat': {'text', 'channel'}, 'announce': {'text'},
    }
    if kind not in fields or set(action) - fields[kind] - {'type', 'phaseId', 'requestId'}:
        fail('Unsupported room action fields.')
    if 'phaseId' in action and (type(action['phaseId']) is not int or action['phaseId'] != state['phaseId']):
        fail('The phase changed. Refresh the room and choose again.', 409)
    if state['phase'] == 'closed':
        fail('This room is closed.', 409)
    if kind == 'restart':
        _require_owner(state, actor_id)
        if state['phase'] != 'finished':
            fail('Finish the current round before starting a rematch.', 409)
        for player in state['players']:
            player.update(role=None, alive=not player.get('left', False), checks=[])
        state.update(day=0, winner=None, nightActions={}, votes={}, ready=[], events=[], chat=[], mafiaChat=[], _messageTimes={})
        _set_phase(state, 'lobby', now)
        _emit(state, 'created', 'A new round is ready. Review the lobby and start when everyone is here.', now)
        return state
    if kind == 'close':
        _require_owner(state, actor_id)
        _set_phase(state, 'closed', now)
        state['nightActions'] = {}; state['votes'] = {}
        _emit(state, 'closed', 'The creator closed this room.', now)
        return state
    if kind == 'leave':
        if actor_id == state['ownerId'] or _is_narrator(state, actor_id):
            fail('The creator or narrator should close the room rather than abandon it.', 409)
        actor['left'] = True; actor['alive'] = False
        if state['phase'] != 'lobby':
            state['nightActions'].pop(actor_id, None); state['votes'].pop(actor_id, None)
        _emit(state, 'left', actor['name'] + ' left the room.', now)
        if state['phase'] not in {'lobby', 'finished'}:
            _check_winner(state, now)
        return reconcile(state, now)
    if kind in {'configure', 'kick', 'reassign-narrator', 'start'}:
        _require_owner(state, actor_id)
        if state['phase'] != 'lobby':
            fail('This setting can only change before the round starts.', 409)
        if kind == 'configure':
            updated = validate_settings(action.get('settings'), state['settings'])
            mode = action.get('narratorMode', state['narratorMode'])
            if not isinstance(mode, str) or mode not in {'human', 'ai'}:
                fail('Choose a human or AI narrator.')
            narrator_id = None if mode == 'ai' else state['narratorId'] or state['ownerId']
            active_count = sum(player['id'] != narrator_id and not player.get('left') for player in state['players'])
            if active_count > updated['maxPlayers']:
                fail('The selected limit cannot fit everyone already in the room.', 409)
            state['settings'] = updated; state['narratorMode'] = mode; state['narratorId'] = narrator_id
            return state
        if kind == 'kick':
            target = _player(state, _identifier(action.get('targetId')))
            if target['id'] in {state['ownerId'], state['narratorId']}:
                fail('Reassign the narrator before removing that seat.', 409)
            state['players'] = [player for player in state['players'] if player['id'] != target['id']]
            _emit(state, 'left', target['name'] + ' was removed from the lobby.', now)
            return state
        if kind == 'reassign-narrator':
            if state['narratorMode'] != 'human':
                fail('Choose human narration before assigning a narrator.', 409)
            target = _player(state, _identifier(action.get('targetId')))
            if target.get('left'):
                fail('Choose a player still in the lobby.')
            state['narratorId'] = target['id']
            _emit(state, 'narrator', target['name'] + ' is now the narrator. The creator keeps room controls.', now)
            return state
        players = _active(state)
        if not 5 <= len(players) <= state['settings']['maxPlayers']:
            fail('Mafia needs at least five players, in addition to a human narrator.', 409)
        mafia_count = max(1, len(players) // 4)
        roles = ['mafia'] * mafia_count + ['detective', 'doctor'] + ['civilian'] * (len(players) - mafia_count - 2)
        secrets.SystemRandom().shuffle(roles)
        for player, role in zip(players, roles):
            player['role'] = role; player['alive'] = True; player['checks'] = []
        state['day'] = 1
        _emit(state, 'start', 'Secret roles have been assigned. Keep your own role private.', now)
        _set_phase(state, 'night', now)
        return state
    if kind == 'announce':
        _require_narrator(state, actor_id)
        text = _text(action.get('text'), 240, 'Announcement')
        _message(state, actor, text, 'public', now)
        _emit(state, 'announcement', text, now)
        return state
    if kind == 'advance':
        _require_narrator(state, actor_id)
        if type(action.get('force', False)) is not bool:
            fail('Invalid phase control.')
        if state['phase'] not in {'night', 'discussion', 'voting'}:
            fail('This room has no phase to advance.', 409)
        # A human can open voting after discussion; hidden choices must all be
        # present unless the explicit timeout override is used after deadline.
        if state['phase'] != 'discussion' and not _phase_ready(state):
            if not action.get('force') or now < state['deadlineAt']:
                fail('Wait for the remaining choices, or use the timeout override after the timer ends.', 409)
        _advance(state, now)
        return state
    if kind == 'chat':
        channel = action.get('channel', 'public')
        if not isinstance(channel, str) or channel not in {'public', 'mafia'}:
            fail('Choose an available chat channel.')
        if _is_narrator(state, actor_id):
            if channel != 'public':
                fail('The narrator can announce to the whole room.', 403)
        elif not actor['alive'] or actor.get('left'):
            fail('Eliminated players can watch but cannot send messages.', 403)
        elif channel == 'mafia':
            if state['phase'] != 'night' or actor['role'] != 'mafia':
                fail('Mafia chat is only available to living Mafia at night.', 403)
        elif state['phase'] not in {'lobby', 'discussion', 'voting', 'finished'}:
            fail('Public discussion opens during the day.', 409)
        _message(state, actor, action.get('text'), channel, now)
        return state
    if not actor['alive'] or actor.get('left') or _is_narrator(state, actor_id):
        fail('Only living players can make this choice.', 403)
    if kind == 'night-action':
        if state['phase'] != 'night' or actor['role'] not in {'mafia', 'doctor', 'detective'}:
            fail('Your role has no choice in this phase.', 409)
        target = _player(state, _identifier(action.get('targetId')))
        if not target['alive'] or target.get('left') or target['id'] == state['narratorId']:
            fail('Choose a living player.')
        if actor['role'] == 'mafia' and target['role'] == 'mafia':
            fail('The Mafia must choose someone outside its team.')
        if actor['role'] == 'detective' and target['id'] == actor_id:
            fail('Investigate another player.')
        state['nightActions'][actor_id] = target['id']
    elif kind == 'vote':
        if state['phase'] != 'voting':
            fail('Voting is not open.', 409)
        target_id = action.get('targetId')
        if target_id != 'skip':
            target = _player(state, _identifier(target_id))
            if not target['alive'] or target.get('left') or target['id'] == state['narratorId']:
                fail('Vote for a living player or skip.')
        state['votes'][actor_id] = target_id
    elif kind == 'ready':
        if state['phase'] != 'discussion':
            fail('Ready is only available during discussion.', 409)
        if actor_id not in state['ready']:
            state['ready'].append(actor_id)
    return reconcile(state, now)


def project(state, viewer_id, now=None):
    """Return only the authenticated seat's view; never serialize private state."""
    _now(now)
    viewer = _player(state, _identifier(viewer_id))
    narrator = _is_narrator(state, viewer_id)
    mafia = viewer['role'] == 'mafia' and viewer['alive'] and not viewer.get('left')
    finished = state['phase'] == 'finished'
    players = []
    for player in state['players']:
        item = {field: player[field] for field in ('id', 'name', 'avatar', 'alive')}
        item['isNarrator'] = player['id'] == state['narratorId']
        item['left'] = bool(player.get('left'))
        if finished and player['role'] is not None:
            item['role'] = player['role']
        players.append(item)
    result = {field: deepcopy(state[field]) for field in ('version', 'roomId', 'phase', 'phaseId', 'day', 'ownerId', 'narratorId', 'narratorMode', 'settings', 'createdAt', 'deadlineAt', 'winner')}
    result['players'] = players
    result['self'] = {
        'id': viewer_id, 'role': viewer['role'], 'alive': viewer['alive'],
        'left': bool(viewer.get('left')),
        'isOwner': state['ownerId'] == viewer_id, 'isNarrator': narrator,
        'nightTargetId': state['nightActions'].get(viewer_id) if state['phase'] == 'night' else None,
        'voteTargetId': state['votes'].get(viewer_id) if state['phase'] == 'voting' else None,
        'hasVoted': state['phase'] == 'voting' and viewer_id in state['votes'],
        'ready': viewer_id in state['ready'], 'checks': deepcopy(viewer['checks']) if viewer['role'] == 'detective' else [],
        'allies': [player['id'] for player in state['players'] if player['role'] == 'mafia' and player['id'] != viewer_id] if mafia else [],
    }
    result['events'] = deepcopy(state['events'])
    result['chat'] = deepcopy(state['chat'])
    result['mafiaChat'] = deepcopy(state['mafiaChat']) if mafia or narrator else []
    if narrator:
        required = len(_required_night(state)) if state['phase'] == 'night' else len(_living(state)) if state['phase'] in {'discussion', 'voting'} else 0
        submitted = len(state['nightActions']) if state['phase'] == 'night' else len(state['votes']) if state['phase'] == 'voting' else len(state['ready']) if state['phase'] == 'discussion' else 0
        result['narratorInfo'] = {
            'roles': [{'playerId': player['id'], 'role': player['role']} for player in state['players'] if player['role'] is not None],
            'nightActions': deepcopy(state['nightActions']) if state['phase'] == 'night' else {},
            'readyToAdvance': state['phase'] == 'discussion' or _phase_ready(state),
            'submitted': submitted, 'required': required,
        }
    return result
