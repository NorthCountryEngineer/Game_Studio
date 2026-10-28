"""Pure, bounded word-game data and layouts, mirrored by word-game-engine.ts.

This module performs no I/O. The API stores authored data; the fixed player
reconstructs the same complete layout from the saved vocabulary and seed.
"""
from copy import deepcopy
import math
import re


JS_WHITESPACE = ' \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
SPACE = '[' + re.escape(JS_WHITESPACE) + ']'
UNSAFE_TEXT = re.compile(r'[\x00-\x1f\x7f-\x9f<>]|[a-z][a-z0-9+.-]*://|www\.|(?:javascript|data|vbscript|mailto|file|tel)' + SPACE + r'*:|\b(?:eval|fetch|import)' + SPACE + r'*\(', re.I | re.ASCII)
TOKEN = re.compile(r'\{\{(blank-(?:[1-9]|1[0-2]))\}\}')
ASCII_CASE_FOLD = str.maketrans({**{ord(chr(c)): chr(c + 32) for c in range(65, 91)}, 0x17f: 's', 0x212a: 'k'})
CROSSWORD_WORK_LIMIT = 2000000
FIELD = re.compile(SPACE + r'*(title|description|instructions|seed|size|backwards|words|entries|template|blanks)' + SPACE + r'*:' + SPACE + r'*([^\n\r\u2028\u2029]*?)' + SPACE + r'*', re.I | re.ASCII)


class WordGameError(Exception):
    pass


def fail(message):
    raise WordGameError(message)


def fields(value, keys, label):
    if not isinstance(value, dict): fail(label + ' must be an object.')
    if set(value) != set(keys): fail(label + ' has missing or unexpected fields.')
    return value


def text(value, maximum, label, empty=False):
    if (not isinstance(value, str) or (not empty and not value.strip(JS_WHITESPACE))
            or value != value.strip(JS_WHITESPACE)
            or len(value.encode('utf-16-le', errors='surrogatepass')) // 2 > maximum
            or UNSAFE_TEXT.search(value.translate(ASCII_CASE_FOLD))):
        fail(f'{label} must be plain text up to {maximum} characters, without links or code.')
    try: value.encode('utf-8')
    except UnicodeEncodeError: fail(f'{label} must be plain text up to {maximum} characters, without links or code.')
    return value


def integer(value, minimum, maximum, label):
    if (type(value) not in {int, float} or not minimum <= value <= maximum or value != int(value)):
        fail(f'{label} must be a whole number from {minimum} to {maximum}.')
    return int(value)


def word(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Z]{2,18}', value):
        fail('Words must use 2 to 18 uppercase ASCII letters.')
    return value


def crossword(spec, *, work_limit=None):
    if work_limit is None: work_limit = CROSSWORD_WORK_LIMIT
    if type(work_limit) is not int or not 1 <= work_limit <= CROSSWORD_WORK_LIMIT:
        fail('Crossword layout work limit is invalid.')
    size, entries = 25, spec['puzzle']['entries']
    grid, masks = [[''] * 25 for _ in range(25)], [[0] * 25 for _ in range(25)]
    placed, nodes, work = [], 0, 0
    root = sorted(range(len(entries)), key=lambda i: (-len(entries[i]['answer']), i))[0]

    def inside(row, col): return 0 <= row < size and 0 <= col < size
    def occupied(row, col): return inside(row, col) and bool(grid[row][col])

    def tick():
        nonlocal work
        work += 1
        if work > work_limit:
            fail('Crossword layout search reached its work limit. Edit the vocabulary or seed; every word must fit.')

    def candidate(index, row, col, direction):
        answer, clue = entries[index]['answer'], entries[index]['clue']
        dr, dc = (1, 0) if direction == 'down' else (0, 1)
        bit = 2 if dr else 1
        if (not inside(row, col) or not inside(row + dr * (len(answer) - 1), col + dc * (len(answer) - 1))
                or occupied(row - dr, col - dc) or occupied(row + dr * len(answer), col + dc * len(answer))):
            return None
        crossings = 0
        for k, letter in enumerate(answer):
            tick()
            r, c = row + dr * k, col + dc * k
            if grid[r][c]:
                if grid[r][c] != letter or masks[r][c] & bit: return None
                crossings += 1
            elif occupied(r - dc, c - dr) or occupied(r + dc, c + dr): return None
        if placed and not crossings: return None
        rank = (int(spec['puzzle']['seed']) ^ ((row + 1) * 73856093)
            ^ ((col + 1) * 19349663) ^ ((index + 1) * 83492791) ^ (2654435761 if dr else 0)) & 0xffffffff
        return {'answer': answer, 'clue': clue, 'row': row, 'col': col, 'direction': direction,
            'index': index, 'crossings': crossings, 'rank': rank}

    def apply(p, remove=False):
        dr, dc = (1, 0) if p['direction'] == 'down' else (0, 1)
        bit = 2 if dr else 1
        for k, letter in enumerate(p['answer']):
            r, c = p['row'] + dr * k, p['col'] + dc * k
            masks[r][c] = masks[r][c] & ~bit if remove else masks[r][c] | bit
            grid[r][c] = letter if masks[r][c] else ''

    def candidates(index):
        result, seen, answer = [], set(), entries[index]['answer']
        for r in range(size):
            for c in range(size):
                tick()
                if not grid[r][c]: continue
                for k, letter in enumerate(answer):
                    tick()
                    if letter != grid[r][c]: continue
                    for direction in ('across', 'down'):
                        row, col = r - (k if direction == 'down' else 0), c - (k if direction == 'across' else 0)
                        key = (row, col, direction)
                        if key in seen: continue
                        seen.add(key)
                        p = candidate(index, row, col, direction)
                        if p: result.append(p)
        return sorted(result, key=lambda p: (-p['crossings'], p['rank'], p['row'], p['col'], 0 if p['direction'] == 'across' else 1))[:48]

    def search():
        nonlocal nodes
        if len(placed) == len(entries): return True
        if nodes >= 2000: return False
        taken = {p['index'] for p in placed}
        choices = [(index, candidates(index)) for index in range(len(entries)) if index not in taken]
        choices = sorted((choice for choice in choices if choice[1]), key=lambda choice: (len(choice[1]), -len(entries[choice[0]]['answer']), choice[0]))
        for _, options in choices:
            for p in options:
                nodes += 1
                if nodes > 2000: return False
                apply(p); placed.append(p)
                if search(): return True
                placed.pop(); apply(p, True)
        return False

    first = candidate(root, 12, (size - len(entries[root]['answer'])) // 2, 'across')
    apply(first); placed.append(first)
    if not search():
        fail('These words could not form a connected crossword within the fixed 25 by 25 layout. Edit the vocabulary or seed; every word must fit.')
    starts = sorted({p['row'] * size + p['col'] for p in placed})
    return {'size': size, 'grid': grid, 'entries': [{name: p[name] for name in ('answer', 'clue', 'row', 'col', 'direction')}
        | {'number': starts.index(p['row'] * size + p['col']) + 1} for p in sorted(placed, key=lambda p: p['index'])]}


def word_search(spec):
    p = spec['puzzle']; size, words, allow_backwards = p['size'], p['words'], p['allowBackwards']
    seed, grid, placements = int(p['seed']) & 0xffffffff, [[''] * size for _ in range(size)], []

    def random():
        nonlocal seed
        seed = (seed * 1664525 + 1013904223) & 0xffffffff
        return seed / 4294967296

    dirs = [(0, 1), (1, 0), (1, 1), (-1, 1)] + ([(0, -1), (-1, 0), (-1, -1), (1, -1)] if allow_backwards else [])
    ordered = sorted(enumerate(words), key=lambda item: (-len(item[1]), item[0]))
    for _, value in ordered:
        found = False
        for _ in range(240):
            dr, dc = dirs[math.floor(random() * len(dirs))]
            row, col = math.floor(random() * size), math.floor(random() * size)
            if not 0 <= row + dr * (len(value) - 1) < size or not 0 <= col + dc * (len(value) - 1) < size: continue
            if any(grid[row + dr * k][col + dc * k] and grid[row + dr * k][col + dc * k] != letter for k, letter in enumerate(value)): continue
            for k, letter in enumerate(value): grid[row + dr * k][col + dc * k] = letter
            placements.append({'word': value, 'row': row, 'col': col, 'dr': dr, 'dc': dc}); found = True; break
        if not found:
            placements = []; break
    if len(placements) != len(words):
        seed, grid, placements = int(p['seed']) & 0xffffffff, [[''] * size for _ in range(size)], []
        for row, value in enumerate(words):
            col = math.floor(random() * (size - len(value) + 1))
            for k, letter in enumerate(value): grid[row][col + k] = letter
            placements.append({'word': value, 'row': row, 'col': col, 'dr': 0, 'dc': 1})
    for row in range(size):
        for col in range(size):
            if not grid[row][col]: grid[row][col] = chr(65 + math.floor(random() * 26))
    return {'size': size, 'grid': grid, 'placements': placements}


def validate_spec(value):
    data = fields(value, ('version', 'title', 'description', 'genre', 'instructions', 'puzzle'), 'Word game')
    if type(data['version']) not in {int, float} or data['version'] != 3: fail('Unsupported word game version.')
    common = {'version': 3, 'title': text(data['title'], 80, 'Title'), 'description': text(data['description'], 300, 'Description', True),
        'instructions': text(data['instructions'], 300, 'Instructions', True)}
    if data['genre'] == 'crossword':
        p = fields(data['puzzle'], ('seed', 'entries'), 'Crossword puzzle')
        seed = integer(p['seed'], 1, 2147483647, 'Layout seed')
        if not isinstance(p['entries'], list) or not 3 <= len(p['entries']) <= 16: fail('A crossword needs 3 to 16 entries.')
        entries = []
        for raw in p['entries']:
            e = fields(raw, ('answer', 'clue'), 'Crossword entry')
            entries.append({'answer': word(e['answer']), 'clue': text(e['clue'], 140, 'Clue')})
        if len({e['answer'] for e in entries}) != len(entries): fail('Crossword answers must be unique.')
        if sum(len(e['answer']) for e in entries) > 200: fail('Crossword answers must total at most 200 letters.')
        spec = {**common, 'genre': 'crossword', 'puzzle': {'seed': seed, 'entries': entries}}
        crossword(spec)
        return spec
    if data['genre'] == 'word-search':
        p = fields(data['puzzle'], ('seed', 'size', 'allowBackwards', 'words'), 'Word search puzzle')
        seed, size = integer(p['seed'], 1, 2147483647, 'Layout seed'), integer(p['size'], 10, 24, 'Grid size')
        if type(p['allowBackwards']) is not bool: fail('Allow backwards must be true or false.')
        if not isinstance(p['words'], list) or not 3 <= len(p['words']) <= 16 or len(p['words']) > size:
            fail('A word search needs 3 to 16 words, with no more words than grid rows.')
        words = [word(value) for value in p['words']]
        if len(set(words)) != len(words): fail('Word search words must be unique.')
        if any(len(value) > size for value in words): fail('Every word must fit the grid size.')
        return {**common, 'genre': 'word-search', 'puzzle': {'seed': seed, 'size': size, 'allowBackwards': p['allowBackwards'], 'words': words}}
    if data['genre'] == 'mad-libs':
        p = fields(data['puzzle'], ('template', 'blanks'), 'Mad Libs puzzle')
        template = text(p['template'], 2000, 'Template')
        if not isinstance(p['blanks'], list) or not 1 <= len(p['blanks']) <= 12: fail('A Mad Libs story needs 1 to 12 blanks.')
        blanks = []
        for raw in p['blanks']:
            b = fields(raw, ('id', 'label'), 'Blank')
            if not isinstance(b['id'], str) or not re.fullmatch(r'blank-(?:[1-9]|1[0-2])', b['id']): fail('Blank identifiers must be blank-1 through blank-12.')
            blanks.append({'id': b['id'], 'label': text(b['label'], 60, 'Blank label')})
        ids = [b['id'] for b in blanks]
        if len(set(ids)) != len(ids): fail('Blank identifiers must be unique.')
        tokens = TOKEN.findall(template)
        if re.search(r'[{}]', TOKEN.sub('', template)) or any(token not in ids for token in tokens) or any(value not in tokens for value in ids):
            fail('Use only declared {{blank-N}} tokens, and use every declared blank in the story.')
        return {**common, 'genre': 'mad-libs', 'puzzle': {'template': template, 'blanks': blanks}}
    fail('Choose crossword, word-search, or mad-libs.')


def story(spec, answers):
    clean = {b['id']: text(answers.get(b['id']), 80, 'Answer') for b in spec['puzzle']['blanks']}
    return TOKEN.sub(lambda match: clean[match[1]], spec['puzzle']['template'])


PACKS = {
    'nature': [('WATER', 'A liquid that plants and animals need'), ('RIVER', 'A stream of water flowing toward a lake or sea'), ('RAIN', 'Water falling from clouds'), ('TREE', 'A tall plant with a trunk'), ('EARTH', 'The planet we call home')],
    'space': [('PLANET', 'A large world that orbits a star'), ('STAR', 'A glowing ball of gas in space'), ('ORBIT', 'The path around a planet or star'), ('MOON', 'A natural companion orbiting a planet'), ('COMET', 'An icy object that can grow a glowing tail')],
    'animals': [('AXOLOTL', 'An aquatic salamander with feathery external gills'), ('WATER', 'The liquid home of an axolotl'), ('POND', 'A small body of still fresh water'), ('GILLS', 'Body parts that help aquatic animals breathe'), ('TAIL', 'The rear body part an axolotl uses to swim')],
    'garden': [('FLOWER', 'The colorful part of many plants'), ('ROOT', 'A plant part that takes up water from soil'), ('LEAF', 'A plant part that catches sunlight'), ('SEED', 'A small beginning from which a plant can grow'), ('SOIL', 'The ground in which garden plants grow')],
    'science': [('ATOM', 'A tiny unit of a chemical element'), ('ENERGY', 'The capacity to do work or cause change'), ('MATTER', 'Anything that has mass and takes up space'), ('FORCE', 'A push or a pull'), ('LIGHT', 'Visible electromagnetic radiation')],
}


def word_game_directives(message):
    """Authored field content never requests a different genre or topic."""
    continuation, prose = False, []
    for line in message.split('\n'):
        field = FIELD.fullmatch(line)
        if field:
            continuation = field[1].lower() in {'words', 'entries', 'template', 'blanks'}
            continue
        if not continuation: prose.append(line)
    return '\n'.join(prose)


def requested_genre(message):
    if not isinstance(message, str): return None
    message = word_game_directives(message)
    for genre, pattern in [('crossword', r'\bcrossword\b'), ('word-search', r'\bword[ -]?search\b'), ('mad-libs', r'\bmad[ -]?libs?\b')]:
        if re.search(pattern, message.translate(ASCII_CASE_FOLD), re.ASCII): return genre
    return None


def topic_key(message):
    lower = message.lower()
    for key, pattern in [('space', r'\b(space|planets?|astronomy|solar system)\b'), ('animals', r'\b(animals?|axolotls?|pond)\b'),
            ('garden', r'\b(garden|plants?|flowers?)\b'), ('science', r'\b(science|physics|atoms?)\b'), ('nature', r'\b(nature|water|earth)\b')]:
        if re.search(pattern, lower, re.ASCII): return key
    return None


def default_spec(genre='crossword', topic='nature'):
    key = topic_key(topic) or 'nature'
    entries = [{'answer': answer, 'clue': clue} for answer, clue in PACKS[key]]
    common = {'version': 3, 'title': key.capitalize() + ' ' + ('Crossword' if genre == 'crossword' else 'Word Search' if genre == 'word-search' else 'Mad Libs'),
        'description': f'A free guided {key} word game. Review and edit the content before publishing.', 'instructions': ''}
    if genre == 'crossword':
        return validate_spec({**common, 'genre': genre, 'instructions': 'Fill the numbered across and down clues. Check your letters, or reveal the solution after trying.', 'puzzle': {'seed': 17031, 'entries': entries}})
    if genre == 'word-search':
        return validate_spec({**common, 'genre': genre, 'instructions': 'Select the first and last letter of each hidden word in a straight line. Use a pointer, or arrows and Enter.', 'puzzle': {'seed': 17031, 'size': 12, 'allowBackwards': False, 'words': [e['answer'] for e in entries]}})
    templates = {
        'nature': 'One day, a {{blank-1}} explorer took a {{blank-2}} to the park. There they decided to {{blank-3}} beside a {{blank-1}} tree.',
        'space': 'One day, a {{blank-1}} explorer took a {{blank-2}} aboard a spaceship. They decided to {{blank-3}} beside a {{blank-1}} planet.',
        'animals': 'A {{blank-1}} axolotl found a {{blank-2}} in the pond. It decided to {{blank-3}} while a {{blank-1}} turtle watched.',
        'garden': 'A {{blank-1}} gardener planted a {{blank-2}} beside the flowers. Before lunch, the plants began to {{blank-3}} in the {{blank-1}} garden.',
        'science': 'In the laboratory, a {{blank-1}} scientist placed a {{blank-2}} on the table. The experiment began to {{blank-3}} and made a {{blank-1}} discovery.',
    }
    return validate_spec({**common, 'genre': genre, 'instructions': 'Fill every prompt before revealing your story. Your answers stay in this player.',
        'puzzle': {'template': templates[key],
            'blanks': [{'id': 'blank-1', 'label': 'Adjective'}, {'id': 'blank-2', 'label': 'Noun'}, {'id': 'blank-3', 'label': 'Verb'}]}})


def parse_crossword_entries(value):
    result = []
    for line in re.split(r'[\n;]', value):
        if not line.strip(JS_WHITESPACE): continue
        match = re.fullmatch(SPACE + r'*([A-Za-z\u017f\u212a]{2,18})' + SPACE + r'*[|:]' + SPACE + r'*(.+?)' + SPACE + r'*', line)
        if not match: fail('Write one ANSWER | clue per line, or separate entries with semicolons.')
        result.append({'answer': match[1].upper(), 'clue': match[2].strip(JS_WHITESPACE)})
    return result


def parse_word_list(value):
    return [v.upper() for v in re.split('[' + re.escape(JS_WHITESPACE) + ',;]+', value) if v]


def parse_mad_lib_blanks(value):
    result = []
    for line in re.split(r'[\n;]', value):
        if not line.strip(JS_WHITESPACE): continue
        match = re.fullmatch(SPACE + r'*(blank-(?:[1-9]|1[0-2]))' + SPACE + r'*[|:]' + SPACE + r'*(.+?)' + SPACE + r'*', line)
        if not match: fail('Write one blank-1 | prompt label per line, using blank-1 through blank-12.')
        result.append({'id': match[1], 'label': match[2].strip(JS_WHITESPACE)})
    return result


def js_number(value):
    """Number(string) for the bounded numeric authoring fields."""
    value = value.strip(JS_WHITESPACE)
    if not value: return 0
    if re.fullmatch(r'0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+', value): return int(value, 0)
    if re.fullmatch(r'[+-]?(?:Infinity|(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?))', value, re.ASCII): return float(value)
    return float('nan')


def design_game(message, current=None):
    if (not isinstance(message, str) or not message.strip(JS_WHITESPACE)
            or len(message.encode('utf-16-le', errors='surrogatepass')) // 2 > 2000
            or re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]', message)):
        fail('Describe your game in 1 to 2,000 characters.')
    try: message.encode('utf-8')
    except UnicodeEncodeError: fail('Describe your game in 1 to 2,000 characters.')
    directives = word_game_directives(message)
    genre = requested_genre(message) or (current['genre'] if current else 'crossword')
    topic = topic_key(directives)
    reset = (not current or current['genre'] != genre
        or re.search(r'\b(?:about|topic\s*:|theme\s*:)\s*', directives, re.I | re.ASCII) and bool(topic))
    spec = default_spec(genre, topic or 'nature') if reset else validate_spec(current)
    values, active = {}, ''
    for line in message.split('\n'):
        match = FIELD.fullmatch(line)
        if match: active = match[1].lower(); values[active] = match[2]
        elif active in {'words', 'entries', 'template', 'blanks'}: values[active] += '\n' + line
    spec = deepcopy(spec)
    for name in ('title', 'description', 'instructions'):
        if name in values: spec[name] = values[name].strip(JS_WHITESPACE)
    if spec['genre'] != 'mad-libs' and 'seed' in values: spec['puzzle']['seed'] = js_number(values['seed'])
    if spec['genre'] == 'crossword' and 'entries' in values: spec['puzzle']['entries'] = parse_crossword_entries(values['entries'])
    if spec['genre'] == 'word-search':
        if 'words' in values: spec['puzzle']['words'] = parse_word_list(values['words'])
        if 'size' in values: spec['puzzle']['size'] = js_number(values['size'])
        else:
            size = re.search(r'\b(?:size|grid)\s+(\d+)\b', directives, re.I | re.ASCII)
            if size: spec['puzzle']['size'] = js_number(size[1])
        backwards_match = re.search(r'\b(no backwards|allow backwards|backwards on|backwards off)\b', directives, re.I | re.ASCII)
        backwards = values.get('backwards', backwards_match[1] if backwards_match else None)
        if backwards is not None:
            if re.fullmatch(r'true|yes|on|allow backwards|backwards on', backwards, re.I | re.ASCII): spec['puzzle']['allowBackwards'] = True
            elif re.fullmatch(r'false|no|off|no backwards|backwards off', backwards, re.I | re.ASCII): spec['puzzle']['allowBackwards'] = False
            else: fail('Backwards must be on or off.')
    if spec['genre'] == 'mad-libs':
        if 'template' in values: spec['puzzle']['template'] = values['template'].strip(JS_WHITESPACE)
        if 'blanks' in values: spec['puzzle']['blanks'] = parse_mad_lib_blanks(values['blanks'])
    topic_note = (f'Used the editable curated {topic} starter.' if topic else 'Used the editable curated nature starter; arbitrary-topic content is not generated by this free designer.') if reset else 'Kept your saved content except for the explicit edits above.'
    help_text = ('Edit Entries: ANSWER | clue; ANSWER | clue; ANSWER | clue. Every word must fit one connected crossword.' if spec['genre'] == 'crossword'
        else 'Edit Words: WATER, RIVER, RAIN. Set Size: 12 and Backwards: off.' if spec['genre'] == 'word-search'
        else 'Edit Template: using {{blank-1}} tokens, and Blanks: blank-1 | adjective; blank-2 | noun. Every declared blank must be used.')
    return {'spec': validate_spec(spec), 'reply': f'Updated your {genre} game. {topic_note} {help_text} This free guided designer calls no AI model. Review all content, then complete a playtest before publishing.'}
