"""Isolated model worker for the local Studio. No web framework or cloud API."""
import argparse
import json
from pathlib import Path
import traceback
import zipfile
from generate import GenerationPaused, atomic_json, generate


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    directory = args.directory
    request = json.loads((directory / 'request.json').read_text(encoding='utf-8'))
    state = json.loads((directory / 'state.json').read_text(encoding='utf-8'))
    state.update(id=directory.name, title=request['job']['book']['title'], kind=request.get('kind', 'book'), status='running')
    def update(info):
        state.update(info)
        atomic_json(directory / 'state.json', state)
    config = argparse.Namespace(engine='kokoro', model=None, voice=request['voice'], speed=request['speed'],
                                device=request.get('device', 'auto'), max_chars=300, audio_format='m4a')
    try:
        update({'phase': 'starting'})
        generate(request['job'], directory / 'audiobook.zip', config,
                 progress=update, should_pause=lambda: (directory / 'pause').exists())
        if request.get('readingBook'):
            with zipfile.ZipFile(directory / 'audiobook.zip', 'a', compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr('reading-book.json', json.dumps(request['readingBook'], ensure_ascii=False))
        update({'status': 'ready', 'phase': 'complete'})
    except GenerationPaused:
        update({'status': 'paused', 'phase': 'paused'})
    except Exception as error:
        traceback.print_exc()
        update({'status': 'error', 'phase': 'error', 'error': str(error) or type(error).__name__})


if __name__ == '__main__':
    main()
