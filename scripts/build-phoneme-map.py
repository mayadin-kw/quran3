"""Build a compact Quran word pronunciation map from Quran-MD metadata.

Requires DuckDB with httpfs. The source is
https://huggingface.co/datasets/Buraaq/quran-md-words at revision
a030d8b90f6c4d685e376918906602496c2c2758. Audio is neither downloaded
nor redistributed here.
"""
import json
from pathlib import Path
import duckdb

ROOT = Path(__file__).resolve().parent.parent
connection = duckdb.connect()
connection.execute("INSTALL httpfs")
connection.execute("LOAD httpfs")
urls = [
    f"https://huggingface.co/datasets/Buraaq/quran-md-words/resolve/a030d8b90f6c4d685e376918906602496c2c2758/data/train-{i:05d}-of-00005.parquet"
    for i in range(5)
]
rows = connection.execute(
    "SELECT surah_id, ayah_id, word_index, word_ar, word_tr FROM read_parquet(?) "
    "ORDER BY surah_id, ayah_id, word_index", [urls]
).fetchall()
phonemes = {f"{s}:{a}:{i}": [text, spoken] for s, a, i, text, spoken in rows}
assert len(phonemes) == len(rows) == 77429
path = ROOT / "data/quran-phonemes.json"
path.write_text(json.dumps({"source":"Buraaq/quran-md-words", "modelVocabulary":"TBOGamer22/wav2vec2-quran-phonetics",
    "words": phonemes}, ensure_ascii=False, separators=(",", ":")))
print(f"Wrote {len(phonemes)} word pronunciations to {path}")
