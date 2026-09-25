"""Align Quran-MD phonetic words to the Mushaf's finer word/clitic IDs."""
import json
import re
import unicodedata
from collections import defaultdict, Counter
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
verses = json.loads((ROOT / 'data/quran-index.json').read_text())['verses']
source = json.loads((ROOT / 'data/quran-phonemes.json').read_text())['words']

def lexical(value):
    value = unicodedata.normalize('NFKD', value)
    value = re.sub('[\u064b-\u065f\u0670\u06d6-\u06ed\u0640]', '', value)
    for original, replacement in [('أ','ا'),('إ','ا'),('آ','ا'),('ٱ','ا'),('ى','ي'),('ؤ','و'),('ئ','ي')]:
        value = value.replace(original, replacement)
    return re.sub('[^\u0621-\u064a]', '', value)

def distance(a, b):
    previous = list(range(len(b) + 1))
    for i, x in enumerate(a):
        current = [i + 1]
        for j, y in enumerate(b):
            current.append(min(current[-1] + 1, previous[j+1] + 1, previous[j] + (x != y)))
        previous = current
    return previous[-1]

by_verse = defaultdict(list)
for key, (arabic, phonetic) in source.items():
    verse, position = key.rsplit(':', 1)
    by_verse[verse].append((int(position), arabic, phonetic))

mapping = {}
statistics = Counter()
for verse, raw_words in verses.items():
    words = [word for word in raw_words if lexical(word.get('imlaey') or word['hafs'])]
    targets = sorted(by_verse[verse])
    n, m = len(words), len(targets)
    choices = {}

    @lru_cache(None)
    def solve(i, j):
        if i == n and j == m:
            return 0
        options = []
        if i < n:
            options.append((8 + solve(i+1, j), ('skip-word', 1, 0)))
        if j < m:
            options.append((8 + solve(i, j+1), ('skip-target', 0, 1)))
            target = lexical(targets[j][1])
            for span in range(1, min(5, n-i+1)):
                spoken = lexical(''.join(word.get('imlaey') or word['hafs'] for word in words[i:i+span]))
                error = distance(spoken, target)
                options.append((error*2 + (span-1)*.05 + solve(i+span, j+1), ('map', span, error)))
        cost, decision = min(options, key=lambda option: option[0])
        choices[i, j] = decision
        return cost

    solve(0, 0)
    i = j = 0
    while i < n or j < m:
        kind, span, error = choices[i, j]
        statistics[kind, error] += 1
        if kind == 'map':
            _, arabic, phonetic = targets[j]
            start = words[i]
            mapping[f"{verse}:{start['index']}"] = {
                'phonemes': phonetic, 'span': span, 'sourceArabic': arabic,
                'alignmentDistance': error,
            }
            for offset in range(1, span):
                child = words[i+offset]
                mapping[f"{verse}:{child['index']}"] = {
                    'coveredBy': f"{verse}:{start['index']}",
                    'sourceArabic': arabic, 'alignmentDistance': error,
                }
            i += span
            j += 1
        elif kind == 'skip-word':
            i += 1
        else:
            j += 1

path = ROOT / 'data/quran-pronunciation-map.json'
path.write_text(json.dumps({'source':'Buraaq/quran-md-words', 'words':mapping},
    ensure_ascii=False, separators=(',',':')))
print(f"Aligned {len(mapping)} Mushaf word IDs; exceptions: {statistics.most_common()[-8:]}")
