"""Refresh integrity metadata after changing local application assets."""
import datetime
import hashlib
import json
from pathlib import Path
root = Path(__file__).resolve().parent.parent
path = root / 'data/recitation-assets-manifest.json'
manifest = json.loads(path.read_text())
for group in manifest['groups']:
    for item in group['files']:
        if item['url'].startswith('https://'):
            continue
        content = (root / item['url']).read_bytes()
        item.update(bytes=len(content), sha256=hashlib.sha256(content).hexdigest())
manifest['version'] = '1.1.0'
manifest['generatedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
manifest['totalBytes'] = sum(item['bytes'] for group in manifest['groups'] for item in group['files'])
path.write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')))
