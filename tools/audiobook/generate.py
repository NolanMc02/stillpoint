#!/usr/bin/env python3
"""Turn a Stillpoint narration job into a portable, word-aligned audiobook."""
import argparse
import gc
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import subprocess
import time
import unicodedata
import wave
import zipfile

TOKENIZER = 'stillpoint-v1'
PIPELINE_VERSION = 1


class GenerationPaused(Exception):
    """A requested stop at a resumable passage boundary."""


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(compact(value).encode('utf-8')).hexdigest()


def validate_job(job):
    if job.get('format') != 'stillpoint-narration-job' or job.get('version') != 1 or job.get('tokenizer') != TOKENIZER:
        raise ValueError('Unsupported narration job. Export it from the updated Stillpoint app.')
    blocks = job.get('blocks')
    if not isinstance(blocks, list) or not blocks:
        raise ValueError('The narration job has no passages.')
    seen = set()
    for block in blocks:
        sid = block.get('sid')
        if not isinstance(sid, str) or sid in seen:
            raise ValueError('Passage identities must be unique strings.')
        seen.add(sid)
        if not isinstance(block.get('tokens'), list) or not block['tokens']:
            raise ValueError('Each passage must contain reading tokens.')
        for token in block['tokens']:
            if not isinstance(token.get('w'), str) or not token['w'] or token.get('g') not in (0, 1):
                raise ValueError('Invalid reading token.')
    canonical = [[b['sid'], [[t['w'], t['g']] for t in b['tokens']]] for b in blocks]
    if digest(canonical) != job.get('textHash'):
        raise ValueError('The narration job fingerprint does not match its words.')
    return job


def join_tokens(tokens):
    return ''.join(t['w'] + ('' if t['g'] else ' ') for t in tokens).strip()


def split_job(job, max_chars=300):
    """Bound synthesis input, preferring sentence endings and keeping source offsets."""
    for block in job['blocks']:
        tokens = block['tokens']
        start = 0
        while start < len(tokens):
            stop = start
            sentence = None
            chars = 0
            while stop < len(tokens):
                size = len(tokens[stop]['w']) + (0 if tokens[stop]['g'] else 1)
                if chars + size > max_chars and stop > start:
                    break
                chars += size
                stop += 1
                if re.search(r'[.!?…][”\'"’)]*$', tokens[stop - 1]['w']):
                    sentence = stop
            if stop < len(tokens) and sentence and sentence > start:
                stop = sentence
            if len(join_tokens(tokens[start:stop])) > 2000:
                raise ValueError('An individual reading token is too long to synthesize safely.')
            yield {'sid': block['sid'], 'offset': start, 'tokens': tokens[start:stop], 'text': join_tokens(tokens[start:stop])}
            start = stop


def letters(text):
    return ''.join(c for c in unicodedata.normalize('NFKC', text).casefold() if c.isalnum())


def map_spans(expected, spans, duration_ms):
    """Map overlapping character ranges, supporting one-to-many speech expansions.

    No uniform-duration estimates: mismatched words stop generation for inspection.
    """
    source = ''.join(letters(w) for w in expected)
    actual = ''.join(letters(s['text']) for s in spans)
    if source != actual:
        raise ValueError(f'Alignment text differs from narration text: {source[:100]!r} versus {actual[:100]!r}. No guessed timings were written.')
    indexed = []
    cursor = 0
    for span in spans:
        size = len(letters(span['text']))
        if size:
            begin, end = span.get('startMs'), span.get('endMs')
            if not isinstance(begin, (int, float)) or not isinstance(end, (int, float)) or not math.isfinite(begin) or not math.isfinite(end) or end <= begin:
                raise ValueError(f'Missing or invalid alignment for {span["text"]!r}.')
            indexed.append((cursor, cursor + size, begin, end))
        cursor += size
    result = []
    cursor = 0
    span_index = 0
    previous = 0
    for word in expected:
        stop = cursor + len(letters(word))
        if stop == cursor:
            raise ValueError(f'Reading token has no alignable letters or numbers: {word!r}')
        while span_index < len(indexed) and indexed[span_index][1] <= cursor:
            span_index += 1
        matches = []
        i = span_index
        while i < len(indexed) and indexed[i][0] < stop:
            matches.append(indexed[i])
            i += 1
        if not matches:
            raise ValueError(f'No alignment found for {word!r}.')
        begin = max(0, min(duration_ms, round(matches[0][2], 3)))
        end = max(0, min(duration_ms, round(matches[-1][3], 3)))
        if begin < previous or end <= begin:
            raise ValueError(f'Invalid timing range for {word!r}.')
        result.append({'startMs': begin, 'endMs': end})
        previous = begin
        cursor = stop
    return result


def spoken_token(text):
    """Explicit English expansions; the display-to-spoken mapping stays in the job."""
    from num2words import num2words
    text = text.replace('’', "'")
    currencies = {'$': 'dollar', '£': 'pound', '€': 'euro'}
    def currency(match):
        amount = match.group(2).replace(',', '')
        if '.' in amount:
            whole, fractional = amount.split('.')
            return f'{num2words(int(whole))} {currencies[match.group(1)]}{"s" if int(whole) != 1 else ""} and {num2words(int(fractional.ljust(2, "0")))} cents'
        number = int(amount)
        return f'{num2words(number)} {currencies[match.group(1)]}{"s" if number != 1 else ""}'
    text = re.sub(r'([$£€])(\d[\d,]*(?:\.\d{1,2})?)', currency, text)
    text = re.sub(r'\b\d+(?:,\d{3})*(?:\.\d+)?\b', lambda m: num2words(m.group().replace(',', '')), text)
    return text.replace('%', ' percent').replace('&', ' and ').replace('@', ' at ').replace('+', ' plus ')


def wav_duration(path):
    with wave.open(str(path), 'rb') as audio:
        return audio.getnframes() * 1000 / audio.getframerate()


def checksum(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def atomic_json(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(compact(value), encoding='utf-8')
    temp.replace(path)


def package_audio(wav, audio_format):
    if audio_format == 'wav':
        return wav
    import imageio_ffmpeg
    encoded = wav.with_suffix('.m4a')
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                    '-i', str(wav), '-map_metadata', '-1', '-c:a', 'aac', '-b:a', '64k',
                    '-movflags', '+faststart', str(encoded)], check=True)
    return encoded


def combine_clips(clips, destination, engine):
    """Stream PCM into one track; shift word times using exact source sample counts.

    A continuous native audio resource does not need background JS for clip changes.
    """
    words = []
    frames = 0
    parameters = None
    with wave.open(str(destination), 'wb') as output:
        for chunk, wav, record in clips:
            with wave.open(str(wav), 'rb') as source:
                current = (source.getnchannels(), source.getsampwidth(), source.getframerate())
                if parameters is None:
                    parameters = current
                    output.setnchannels(current[0])
                    output.setsampwidth(current[1])
                    output.setframerate(current[2])
                if parameters != current:
                    raise ValueError('Synthesis clips have different audio formats. They cannot be joined without resampling.')
                if (frames + source.getnframes()) * current[0] * current[1] > 0xFFFFFF00:
                    raise ValueError('This selection exceeds the prototype’s continuous PCM size limit. Generate a shorter reading-text selection.')
                offset_ms = frames * 1000 / current[2]
                mapped = map_spans(record['expected'], record['spans'], record['durationMs'])
                words.extend({'sid': chunk['sid'], 'offset': chunk['offset'] + i,
                              'startMs': round(timing['startMs'] + offset_ms, 3),
                              'endMs': round(timing['endMs'] + offset_ms, 3),
                              'status': 'model-duration' if engine == 'kokoro' else 'forced-alignment'}
                             for i, timing in enumerate(mapped))
                while data := source.readframes(65536):
                    output.writeframesraw(data)
                frames += source.getnframes()
    return {'durationMs': frames * 1000 / parameters[2], 'words': words}


def generate(job, output, args, progress=None, should_pause=None):
    from engines import KokoroEngine, QwenEngine
    job = validate_job(job)
    chunks = list(split_job(job, args.max_chars))
    cache = output.with_suffix('.work')
    cache.mkdir(parents=True, exist_ok=True)
    config = {'pipeline': PIPELINE_VERSION, 'engine': args.engine, 'model': args.model,
              'voice': args.voice, 'speed': args.speed, 'device': args.device}
    engine = None
    pending = []
    clips = []
    started = time.monotonic()
    def notify(phase, completed=0, total=len(chunks), **extra):
        if progress:
            progress({'phase': phase, 'completed': completed, 'total': total, 'elapsedSeconds': round(time.monotonic() - started, 1), **extra})
    def checkpoint():
        if should_pause and should_pause():
            raise GenerationPaused()
    for index, chunk in enumerate(chunks):
        checkpoint()
        notify('synthesis', index, passage=chunk['text'][:160])
        key = digest([config, chunk])
        wav = cache / f'{key}.wav'
        metadata = cache / f'{key}.json'
        record = None
        if metadata.exists() and wav.exists():
            try:
                candidate = json.loads(metadata.read_text(encoding='utf-8'))
                if candidate['sha256'] == checksum(wav) and abs(candidate['durationMs'] - wav_duration(wav)) < 1:
                    record = candidate
            except (ValueError, KeyError, wave.Error, EOFError):
                pass
        if record is None:
            if engine is None:
                notify('loading', index)
                engine = KokoroEngine(args) if args.engine == 'kokoro' else QwenEngine(args)
            print(f'Generating {index + 1}/{len(chunks)}: {chunk["text"][:65]}', flush=True)
            expected, spans = engine.synthesize(chunk, wav)
            record = {'durationMs': wav_duration(wav), 'expected': expected, 'spans': spans, 'sha256': checksum(wav)}
            atomic_json(metadata, record)
        else:
            print(f'Resuming {index + 1}/{len(chunks)} from cache', flush=True)
        clips.append((chunk, wav, record))
        if record['spans'] is None:
            pending.append((wav, metadata, record))
        notify('synthesis', index + 1)
    # Keep only one large model resident, including on an 8 GB GPU.
    del engine
    gc.collect()
    if args.engine == 'qwen':
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    if pending:
        checkpoint()
        notify('alignment', len(chunks))
        # Upstream qwen-tts and qwen-asr pin incompatible Transformers versions.
        # An isolated aligner process also guarantees synthesis GPU memory is released.
        request = cache / 'alignment-request.json'
        atomic_json(request, [{'audio': str(wav.resolve()), 'metadata': str(metadata.resolve())} for wav, metadata, _ in pending])
        subprocess.run([args.align_python, str(Path(__file__).with_name('align_worker.py').resolve()),
                        str(request.resolve()), '--device', args.device], check=True)
        for _, metadata, record in pending:
            record.update(json.loads(metadata.read_text(encoding='utf-8')))
    manifest = {'format': 'stillpoint-audiobook', 'version': 1, 'tokenizer': TOKENIZER,
                'textHash': job['textHash'], 'book': job['book'], 'generator': config, 'clips': []}
    continuous = cache / 'continuous.wav'
    checkpoint()
    notify('assembly', len(chunks))
    timing = combine_clips(clips, continuous, args.engine)
    notify('encoding', len(chunks))
    encoded = package_audio(continuous, args.audio_format)
    filename = f'audio/clip-00000.{args.audio_format}'
    manifest['playback'] = 'continuous'
    manifest['clips'].append({'file': filename, **timing})
    temporary = output.with_suffix('.partial')
    try:
        with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.write(encoded, filename, compress_type=zipfile.ZIP_STORED if args.audio_format == 'm4a' else zipfile.ZIP_DEFLATED)
            archive.writestr('audiobook.json', compact(manifest))
            archive.writestr('narration-job.json', compact(job))
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    duration = sum(c['durationMs'] for c in manifest['clips']) / 1000
    elapsed = time.monotonic() - started
    report = {'engine': args.engine, 'voice': args.voice, 'words': sum(len(c['words']) for c in manifest['clips']),
              'audioSeconds': round(duration, 3), 'elapsedSeconds': round(elapsed, 3),
              'generationSecondsPerAudioSecond': round(elapsed / duration, 3)}
    atomic_json(output.with_suffix('.report.json'), report)
    print(f'Saved {output}\n{json.dumps(report, indent=2)}')
    notify('complete', len(chunks), audioSeconds=duration)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('job', type=Path, help='Narration job exported from Stillpoint')
    parser.add_argument('--output', type=Path, default=Path('audiobook.zip'))
    parser.add_argument('--engine', choices=['kokoro', 'qwen'], default='kokoro')
    parser.add_argument('--voice', help='Kokoro preset (af_heart) or Qwen speaker (Ryan)')
    parser.add_argument('--model', help='Override the engine model ID or use a downloaded local model directory')
    parser.add_argument('--align-python', help='Python executable in the separate Qwen aligner environment')
    parser.add_argument('--device', default='auto', choices=['auto', 'cpu', 'cuda', 'mps'])
    parser.add_argument('--speed', type=float, default=1, help='Kokoro synthesis speed; use playback controls for Qwen')
    parser.add_argument('--max-chars', type=int, default=300)
    parser.add_argument('--audio-format', choices=['m4a', 'wav'], default='m4a', help='AAC/M4A for portable audiobooks, WAV for timing inspection')
    parser.add_argument('--validate-only', action='store_true', help='Check job integrity without loading speech models')
    args = parser.parse_args()
    args.voice = args.voice or ('af_heart' if args.engine == 'kokoro' else 'Ryan')
    if not math.isfinite(args.speed) or not 0.5 <= args.speed <= 2 or not 80 <= args.max_chars <= 600:
        parser.error('Speed must be between 0.5 and 2; max-chars must be between 80 and 600.')
    if args.engine == 'qwen' and args.speed != 1:
        parser.error('Qwen uses speed 1. Change playback speed inside Stillpoint.')
    if args.engine == 'qwen' and not args.align_python and not args.validate_only:
        parser.error('Qwen requires --align-python pointing to its separate aligner environment. See tools/audiobook/README.md.')
    try:
        job = validate_job(json.loads(args.job.read_text(encoding='utf-8')))
        if args.validate_only:
            print(f'Valid job: {len(job["blocks"])} passages, {sum(len(b["tokens"]) for b in job["blocks"])} words.')
            return
        args.output.parent.mkdir(parents=True, exist_ok=True)
        generate(job, args.output, args)
    except KeyboardInterrupt:
        print('\nStopped. Run the same command to resume completed clips.', file=sys.stderr)
        sys.exit(130)
    except Exception as error:
        print(f'Generation stopped: {error}\nCompleted clips are saved. Run the same command to resume.', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
