"""Free Mafia computer players that receive only their ordinary seat projection.

No models, network access, omniscient state or executable player text. Choices
use private per-seat randomness plus information a human in that seat can see.
"""
import hashlib

NAMES = ('Nova', 'Ember', 'Juno', 'Pip', 'Sage', 'Milo', 'Echo', 'Robin', 'River', 'Sky',
         'Indigo', 'Sunny', 'Ash', 'Clover', 'Remy', 'Atlas', 'Blair', 'Wren', 'Avery', 'Quinn',
         'Kit', 'Rowan', 'Finley', 'Scout')


def profile(existing_names, avatars):
    used = {name.casefold() for name in existing_names}
    for suffix in ('', ' 2', ' 3'):
        for index, name in enumerate(NAMES):
            name = 'AI ' + name + suffix
            if name.casefold() not in used:
                return {'name': name, 'avatar': avatars[index % len(avatars)]}
    raise ValueError('No computer-player names remain.')


def _rank(seed, tag, value):
    return hashlib.sha256((str(seed) + ':' + tag + ':' + str(value)).encode()).hexdigest()


def _pick(candidates, seed, tag):
    return min(candidates, key=lambda player: _rank(seed, tag, player['id'])) if candidates else None


def decide(view, memory, now):
    """Return one bounded command from this seat's visible information only."""
    phase, own = view['phase'], view['self']
    if phase not in {'night', 'discussion', 'voting'} or not own['alive'] or own.get('left') or own['isNarrator']:
        return None
    if now < memory.get('nextAt', 0):
        return None
    seed = memory['seed']
    phase_key = str(view['phaseId'])
    duration = view['settings'][{'night': 'nightSeconds', 'discussion': 'discussionSeconds', 'voting': 'votingSeconds'}[phase]]
    started = view['deadlineAt'] - duration
    wait = 2 + int(_rank(seed, phase_key, 'delay')[:4], 16) % 3
    if now < started + wait:
        return None
    living = [player for player in view['players'] if player['alive'] and not player.get('left') and not player['isNarrator']]
    others = [player for player in living if player['id'] != own['id']]
    allies = set(own['allies']) | ({own['id']} if own['role'] == 'mafia' else set())
    checks = {check['targetId']: check['isMafia'] for check in own['checks']}
    if phase == 'night':
        if own['nightTargetId'] is not None:
            return None
        if own['role'] == 'mafia':
            candidates = [player for player in living if player['id'] not in allies]
            # Team membership is legitimately visible to each Mafia seat. A
            # common team/day preference avoids accidental split team votes.
            team = ','.join(sorted(allies))
            target = _pick(candidates, team, 'night:' + str(view['day']))
        elif own['role'] == 'detective':
            target = _pick([player for player in others if player['id'] not in checks] or others, seed, 'check:' + phase_key)
        elif own['role'] == 'doctor':
            target = _pick(living, seed, 'protect:' + phase_key)
        else:
            return None
        return {'type': 'night-action', 'targetId': target['id']} if target else None
    candidates = [player for player in others if player['id'] not in allies and checks.get(player['id']) is not False]
    confirmed = [player for player in candidates if checks.get(player['id']) is True]
    suspect = _pick(confirmed or candidates, seed, 'suspect:' + str(view['day']))
    if phase == 'discussion':
        if memory.get('chatPhase') != view['phaseId']:
            if not suspect:
                return {'type': 'chat', 'text': 'I do not have enough evidence yet. Let us compare notes.'}
            if confirmed:
                text = 'My investigation points to ' + suspect['name'] + ' as Mafia. What do you think?'
            else:
                openings = ('I suspect ', 'Something seems off about ', 'Can we discuss ')
                opening = openings[int(_rank(seed, phase_key, 'words')[:4], 16) % len(openings)]
                text = opening + suspect['name'] + '. It is a hunch, so I may be wrong.'
            return {'type': 'chat', 'text': text}
        if now >= started + 4 and not own['ready']:
            return {'type': 'ready'}
        return None
    if own['hasVoted']:
        return None
    return {'type': 'vote', 'targetId': suspect['id'] if suspect else 'skip'}
