"""Split the quantized ONNX model into GitHub browser-uploadable parts."""
import argparse
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('model', type=Path)
parser.add_argument('--part-bytes', type=int, default=24_000_000)
parser.add_argument('--remove-source', action='store_true')
args = parser.parse_args()
if args.part_bytes <= 0:
    parser.error('--part-bytes must be positive')

with args.model.open('rb') as source:
    index = 1
    while block := source.read(args.part_bytes):
        Path(f'{args.model}.part{index}').write_bytes(block)
        index += 1

if args.remove_source:
    args.model.unlink()
print(f'Wrote {index - 1} parts beside {args.model}')
