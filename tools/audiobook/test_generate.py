import argparse
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import wave
import zipfile

from generate import combine_clips, digest, generate, map_spans, split_job, validate_job


def job_for(texts):
    blocks = [{'sid': f'epub:{i}', 'tokens': [{'w': w, 'g': 0} for w in text.split()]} for i, text in enumerate(texts)]
    return {'format': 'stillpoint-narration-job', 'version': 1, 'tokenizer': 'stillpoint-v1',
            'book': {'id': 'test', 'title': 'Test'}, 'blocks': blocks,
            'textHash': digest([[b['sid'], [[t['w'], t['g']] for t in b['tokens']]] for b in blocks])}


class GeneratorTests(unittest.TestCase):
    def test_job_detects_changed_tokens_and_duplicate_passages(self):
        job = job_for(['One two.', 'Three four.'])
        validate_job(job)
        changed = copy.deepcopy(job)
        changed['blocks'][0]['tokens'][0]['w'] = 'Wrong'
        with self.assertRaisesRegex(ValueError, 'fingerprint'):
            validate_job(changed)
        changed = copy.deepcopy(job)
        changed['blocks'][1]['sid'] = changed['blocks'][0]['sid']
        with self.assertRaisesRegex(ValueError, 'unique'):
            validate_job(changed)

    def test_chunks_cover_every_word_in_order(self):
        job = job_for(['One two. Three four five. Six seven eight nine.', 'A second passage.'])
        chunks = list(split_job(job, max_chars=23))
        self.assertTrue(all(len(c['text']) <= 23 for c in chunks))
        actual = [(c['sid'], c['offset'] + i, t['w']) for c in chunks for i, t in enumerate(c['tokens'])]
        expected = [(b['sid'], i, t['w']) for b in job['blocks'] for i, t in enumerate(b['tokens'])]
        self.assertEqual(actual, expected)
        self.assertEqual(chunks[0]['text'], 'One two.')

    def test_alignment_handles_contractions_and_expansions(self):
        spans = [{'text': 'can', 'startMs': 0, 'endMs': 100}, {'text': "'t", 'startMs': 100, 'endMs': 140},
                 {'text': 'twelve', 'startMs': 200, 'endMs': 400}, {'text': 'dollars', 'startMs': 420, 'endMs': 700}]
        result = map_spans(["can't", 'twelve dollars'], spans, 800)
        self.assertEqual(result, [{'startMs': 0, 'endMs': 140}, {'startMs': 200, 'endMs': 700}])

    def test_alignment_rejects_missing_words_and_bad_times(self):
        for spans in [[{'text': 'wrong', 'startMs': 0, 'endMs': 100}],
                      [{'text': 'hello', 'startMs': None, 'endMs': 100}],
                      [{'text': 'hello', 'startMs': 500, 'endMs': 600}]]:
            with self.assertRaises(ValueError):
                map_spans(['hello'], spans, 400)

    def test_resumable_package_has_exact_word_references(self):
        calls = []
        class Engine:
            def __init__(self, args):
                pass
            def synthesize(self, chunk, output):
                calls.append(chunk['text'])
                with wave.open(str(output), 'wb') as audio:
                    audio.setnchannels(1)
                    audio.setsampwidth(2)
                    audio.setframerate(24000)
                    audio.writeframes(b'\0\0' * 24000)
                spans = [{'text': t['w'], 'startMs': i * 100, 'endMs': (i + 1) * 100} for i, t in enumerate(chunk['tokens'])]
                return [t['w'] for t in chunk['tokens']], spans
        args = argparse.Namespace(engine='kokoro', voice='af_heart', model=None, speed=1, device='cpu', max_chars=300, audio_format='wav')
        with tempfile.TemporaryDirectory() as directory, patch('engines.KokoroEngine', Engine):
            output = Path(directory) / 'book.zip'
            job = job_for(['One two.', 'Three four five.'])
            first = generate(job, output, args)
            second = generate(job, output, args)
            self.assertEqual(len(calls), 2)
            self.assertEqual(first, second)
            with zipfile.ZipFile(output) as archive:
                manifest = json.loads(archive.read('audiobook.json'))
                self.assertEqual(manifest['textHash'], job['textHash'])
                self.assertEqual([(w['sid'], w['offset']) for c in manifest['clips'] for w in c['words']],
                                 [('epub:0', 0), ('epub:0', 1), ('epub:1', 0), ('epub:1', 1), ('epub:1', 2)])
                self.assertTrue(all(archive.getinfo(c['file']).file_size > 44 for c in manifest['clips']))
                self.assertEqual(manifest['playback'], 'continuous')
                self.assertEqual(len(manifest['clips']), 1)
                self.assertEqual(manifest['clips'][0]['words'][2]['startMs'], 1000)
                self.assertEqual(manifest['clips'][0]['durationMs'], 2000)
            # Corrupted cache audio is regenerated, never silently reused.
            next(p for p in output.with_suffix('.work').glob('*.wav') if p.name != 'continuous.wav').write_bytes(b'broken')
            generate(job, output, args)
            self.assertEqual(len(calls), 3)


if __name__ == '__main__':
    unittest.main()
