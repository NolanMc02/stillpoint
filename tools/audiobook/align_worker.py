"""Run in the dedicated qwen-asr environment; align cached clips incrementally."""
import argparse
import json
from pathlib import Path
from engines import QwenAligner
from generate import atomic_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('request', type=Path)
    parser.add_argument('--device', default='auto')
    args = parser.parse_args()
    requests = json.loads(args.request.read_text(encoding='utf-8'))
    aligner = QwenAligner(args)
    for i, request in enumerate(requests):
        metadata = Path(request['metadata'])
        record = json.loads(metadata.read_text(encoding='utf-8'))
        print(f'Aligning {i + 1}/{len(requests)}', flush=True)
        record['spans'] = aligner.align(Path(request['audio']), ' '.join(record['expected']))
        atomic_json(metadata, record)


if __name__ == '__main__':
    main()
