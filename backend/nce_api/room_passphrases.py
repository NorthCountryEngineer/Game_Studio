"""Data-only passphrase rules shared by anonymous room adapters.

Phrases are admission capabilities, never account credentials. Only their scoped
hashes enter room/index records; this module makes no network or provider calls.
"""
import hashlib
import json
import re

MAX_ROOMS = 32
SOURCE_ATTEMPTS = 120
INSTALLATION_ATTEMPTS = 600
MAX_SOURCES = 128
MAX_ADMISSIONS = MAX_ROOMS * 24
UNAVAILABLE = 'No open seat matches that passphrase for this game. Check with the host and try again.'


class PassphraseError(ValueError):
    def __init__(self, status, message):
        self.status, self.message = status, message
        super().__init__(message)


def normalize(value):
    if not isinstance(value, str) or len(value) > 96 or not re.fullmatch(r'[A-Za-z0-9 -]+', value):
        raise PassphraseError(400, 'Use 6–48 letters, numbers, spaces or hyphens for the passphrase.')
    normalized = re.sub(' +', ' ', value.strip()).lower()
    if not 6 <= len(normalized) <= 48 or not re.search('[a-z0-9]', normalized):
        raise PassphraseError(400, 'Use 6–48 letters, numbers, spaces or hyphens for the passphrase.')
    return normalized


def digest(scope, value):
    encoded = json.dumps(['room-passphrase-v1', scope, normalize(value)], separators=(',', ':'), ensure_ascii=True)
    return hashlib.sha256(encoded.encode()).hexdigest()


def registry(index):
    phrases = index.setdefault('passphrases', {})
    if not isinstance(phrases, dict) or len(phrases) > MAX_ROOMS or any(
            not isinstance(key, str) or not re.fullmatch('[0-9a-f]{64}', key) or
            not isinstance(room_id, str) or not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', room_id)
            for key, room_id in phrases.items()):
        raise PassphraseError(503, 'Room admission needs administrator attention.')
    return phrases


def prune(index):
    phrases = registry(index)
    for hashed, room_id in list(phrases.items()):
        if room_id not in index['rooms']:
            del phrases[hashed]


def claim(index, hashed, room_id):
    phrases = registry(index)
    if hashed in phrases and phrases[hashed] != room_id:
        raise PassphraseError(409, 'That passphrase is already in use for this game. Choose another.')
    if hashed not in phrases and len(phrases) >= MAX_ROOMS:
        raise PassphraseError(429, 'All passphrase rooms are in use. Try again when another room ends.')
    phrases[hashed] = room_id


def release(index, hashed, room_id):
    phrases = registry(index)
    if phrases.get(hashed) == room_id:
        del phrases[hashed]


def admissions(index, now):
    """Keep exact successful guest requests bound to their original room."""
    receipts = index.setdefault('passphraseAdmissions', {})
    if not isinstance(receipts, dict) or len(receipts) > MAX_ADMISSIONS:
        raise PassphraseError(503, 'Room admission needs administrator attention.')
    for request, receipt in list(receipts.items()):
        if (not isinstance(request, str) or not re.fullmatch('[0-9a-f]{64}', request) or
                not isinstance(receipt, dict) or set(receipt) != {'roomId', 'fingerprint', 'expiresAt'} or
                not isinstance(receipt['roomId'], str) or not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', receipt['roomId']) or
                not isinstance(receipt['fingerprint'], str) or not re.fullmatch('[0-9a-f]{64}', receipt['fingerprint']) or
                type(receipt['expiresAt']) is not int or receipt['expiresAt'] < 0):
            raise PassphraseError(503, 'Room admission needs administrator attention.')
        receipt['expiresAt'] = max(receipt['expiresAt'], index['rooms'].get(receipt['roomId'], 0))
        if receipt['expiresAt'] <= now:
            del receipts[request]
    return receipts


def remember(index, request, fingerprint, room_id, expires, now):
    receipts = admissions(index, now)
    existing = receipts.get(request)
    if existing:
        if existing['roomId'] != room_id or existing['fingerprint'] != fingerprint:
            raise PassphraseError(409, 'This join request has already been used. Start a new request to join another room.')
        existing['expiresAt'] = max(existing['expiresAt'], expires)
        return
    if len(receipts) >= MAX_ADMISSIONS:
        raise PassphraseError(429, 'Many players recently joined. Please wait before joining by passphrase, or use an invitation.')
    receipts[request] = {'roomId': room_id, 'fingerprint': fingerprint, 'expiresAt': expires}


def take_attempt(index, source, now):
    """Bound guesses and counters in the existing index, including failed joins."""
    minute = now // 60
    rate = index.get('passphraseRate')
    if not isinstance(rate, dict) or rate.get('minute') != minute:
        rate = {'minute': minute, 'count': 0, 'sources': {}}
    sources = rate.get('sources')
    if (type(rate.get('count')) is not int or rate['count'] < 0 or not isinstance(sources, dict) or
            len(sources) > MAX_SOURCES or any(not isinstance(key, str) or not re.fullmatch('[0-9a-f]{64}', key) or
                type(value) is not int or value < 0 for key, value in sources.items())):
        raise PassphraseError(503, 'Room admission needs administrator attention.')
    if rate['count'] >= INSTALLATION_ATTEMPTS or sources.get(source, 0) >= SOURCE_ATTEMPTS or source not in sources and len(sources) >= MAX_SOURCES:
        raise PassphraseError(429, 'Too many passphrase attempts. Please wait a minute and try again.')
    rate['count'] += 1
    sources[source] = sources.get(source, 0) + 1
    index['passphraseRate'] = rate
