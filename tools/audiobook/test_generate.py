import argparse
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import wave
import zipfile

from generate import GenerationPaused, atomic_json, combine_clips, digest, generate, map_spans, split_job, validate_job


def job_for(texts):
    blocks = [{'sid': f'epub:{i}', 'tokens': [{'w': w, 'g': 0} for w in text.split()]} for i, text in enumerate(texts)]
    return {'format': 'stillpoint-narration-job', 'version': 1, 'tokenizer': 'stillpoint-v1',
            'book': {'id': 'test', 'title': 'Test'}, 'blocks': blocks,
            'textHash': digest([[b['sid'], [[t['w'], t['g']] for t in b['tokens']]] for b in blocks])}


class GeneratorTests(unittest.TestCase):
    def test_untimed_contraction_fragment_uses_only_its_own_display_word(self):
        for word, suffix in [("don't", "n't"), ('don’t', 'n’t'), ("we're", "'re"), ("she's", "'s")]:
            prefix = 'do' if word.startswith('do') else 'we' if word.startswith('we') else 'she'
            for begin, end in [(None, None), (200, 200)]:
                spans = [{'text': prefix, 'startMs': 100, 'endMs': 200},
                         {'text': suffix, 'startMs': begin, 'endMs': end},
                         {'text': 'ready', 'startMs': 300, 'endMs': 500}]
                result = map_spans([word, 'ready'], spans, 600)
                self.assertEqual(result[0], {'startMs': 100, 'endMs': 200, 'status': 'contraction-group'})
                self.assertEqual(result[1], {'startMs': 300, 'endMs': 500})
        spans = [{'text': 'do', 'startMs': 100, 'endMs': 200}, {'text': "n't", 'startMs': None, 'endMs': None}]
        with self.assertRaisesRegex(ValueError, 'Missing or invalid'):
            map_spans(['do', "n't"], spans, 300)
        for begin, end in [(float('nan'), 200), (200, 100), (None, 200)]:
            spans[1].update(startMs=begin, endMs=end)
            with self.assertRaisesRegex(ValueError, 'Missing or invalid'):
                map_spans(["don't"], spans, 300)

    def test_alignment_failure_is_early_and_cached_audio_can_be_repaired(self):
        calls = []
        class Engine:
            def __init__(self, args): pass
            def synthesize(self, chunk, output):
                calls.append(chunk['text'])
                with wave.open(str(output), 'wb') as audio:
                    audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(24000)
                    audio.writeframes(b'\0\0' * 24000)
                if chunk['text'] == "Don't stop.":
                    return [t['w'] for t in chunk['tokens']], [
                        {'text': 'Do', 'startMs': 0, 'endMs': 100},
                        {'text': "n't", 'startMs': None, 'endMs': None},
                        {'text': 'stop.', 'startMs': 200, 'endMs': 300}]
                return [t['w'] for t in chunk['tokens']], [{'text': t['w'], 'startMs': i * 100, 'endMs': (i + 1) * 100} for i, t in enumerate(chunk['tokens'])]
        args = argparse.Namespace(engine='kokoro', voice='af_heart', model=None, speed=1, device='cpu', max_chars=300, audio_format='wav')
        with tempfile.TemporaryDirectory() as directory, patch('engines.KokoroEngine', Engine):
            output = Path(directory) / 'book.zip'; job = job_for(["Don't stop.", 'Keep reading.'])
            with patch('generate.map_spans', side_effect=ValueError('Missing or invalid alignment')):
                with self.assertRaisesRegex(ValueError, 'Passage 1 of 2'):
                    generate(job, output, args)
            self.assertEqual(len(calls), 1)
            self.assertFalse(output.exists())
            generate(job, output, args)
            self.assertEqual(calls.count("Don't stop."), 1)
            self.assertTrue(output.exists())
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(json.loads(archive.read('audiobook.json'))['clips'][0]['words'][0]['status'], 'contraction-group')

    def test_progress_write_recovers_from_a_brief_windows_file_lock(self):
        original = Path.replace
        attempts = []
        def replace(source, target):
            attempts.append(1)
            if len(attempts) < 3:
                raise PermissionError('File is briefly in use')
            return original(source, target)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'state.json'
            target.write_text('{"completed":1}')
            with patch.object(Path, 'replace', replace), patch('generate.time.sleep'):
                atomic_json(target, {'completed': 2})
            self.assertEqual(json.loads(target.read_text()), {'completed': 2})
            self.assertEqual(list(Path(directory).iterdir()), [target])

    def test_progress_counts_words_and_estimates_only_measured_synthesis(self):
        clock = [0]
        class Engine:
            def __init__(self, args):
                clock[0] += 30  # Loading time must not inflate narration ETA.
            def synthesize(self, chunk, output):
                clock[0] += 2
                with wave.open(str(output), 'wb') as audio:
                    audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(24000)
                    audio.writeframes(b'\0\0' * 24000)
                return [t['w'] for t in chunk['tokens']], [{'text': t['w'], 'startMs': i * 100, 'endMs': (i + 1) * 100} for i, t in enumerate(chunk['tokens'])]
        args = argparse.Namespace(engine='kokoro', voice='af_heart', model=None, speed=1, device='cpu', max_chars=300, audio_format='wav')
        events = []
        with tempfile.TemporaryDirectory() as directory, patch('engines.KokoroEngine', Engine), patch('generate.time.monotonic', side_effect=lambda: clock[0]):
            generate(job_for(['One two.', 'Three four.', 'Five six.']), Path(directory) / 'book.zip', args, progress=events.append)
        measured = next(e for e in events if e['phase'] == 'synthesis' and e['completed'] == 2)
        self.assertEqual((measured['totalWords'], measured['completedWords'], measured['audioSeconds']), (6, 4, 2))
        self.assertEqual(measured['etaSeconds'], 2)
        self.assertIsNone(next(e for e in events if e['phase'] == 'loading')['etaSeconds'])
        self.assertIsNone(next(e for e in events if e['phase'] == 'encoding')['etaSeconds'])

    def test_silent_punctuation_anchors_to_speech_without_hiding_missing_words(self):
        spans = [{'text': 'Hello', 'startMs': 100, 'endMs': 400}, {'text': 'world', 'startMs': 450, 'endMs': 800}]
        mapped = map_spans(['"', 'Hello', '—', 'world', '"'], spans, 900)
        self.assertEqual(mapped[1], {'startMs': 100, 'endMs': 400})
        self.assertEqual(mapped[3], {'startMs': 450, 'endMs': 800})
        self.assertTrue(all(mapped[i]['status'] == 'punctuation-boundary' for i in [0, 2, 4]))
        self.assertTrue(all(a['startMs'] <= b['startMs'] for a, b in zip(mapped, mapped[1:])))
        self.assertTrue(all(t['endMs'] > t['startMs'] for t in mapped))
        with self.assertRaisesRegex(ValueError, 'Alignment text differs'):
            map_spans(['Hello', 'missing', 'world', '"'], spans, 900)

    def test_pause_preserves_completed_passages_for_resume(self):
        calls = []
        class Engine:
            def __init__(self, args): pass
            def synthesize(self, chunk, output):
                calls.append(chunk['text'])
                with wave.open(str(output), 'wb') as audio:
                    audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(24000)
                    audio.writeframes(b'\0\0' * 24000)
                return [t['w'] for t in chunk['tokens']], [{'text': t['w'], 'startMs': i * 150, 'endMs': (i + 1) * 150} for i, t in enumerate(chunk['tokens'])]
        args = argparse.Namespace(engine='kokoro', voice='af_heart', model=None, speed=1, device='cpu', max_chars=300, audio_format='wav')
        events = []
        def pause_after_first(info): events.append(info)
        with tempfile.TemporaryDirectory() as directory, patch('engines.KokoroEngine', Engine):
            output = Path(directory) / 'book.zip'; job = job_for(['First passage.', 'Second passage.'])
            with self.assertRaises(GenerationPaused):
                generate(job, output, args, progress=pause_after_first,
                         should_pause=lambda: any(e['phase'] == 'synthesis' and e['completed'] == 1 for e in events))
            self.assertEqual(len(calls), 1); self.assertFalse(output.exists())
            result = generate(job, output, args)
            self.assertEqual(len(calls), 2)
            self.assertEqual(len(result['clips'][0]['words']), 4)

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
