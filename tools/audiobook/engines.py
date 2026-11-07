"""Optional model adapters. Core validation and tests need no ML dependencies."""
from generate import spoken_token
import os

# Use the normal HTTPS downloader: Xet stalled indefinitely on a first-use voice.
# Set this before Kokoro imports huggingface_hub and its environment constants.
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')
os.environ.setdefault('HF_HUB_DOWNLOAD_TIMEOUT', '20')


def device_for(requested):
    import torch
    if requested != 'auto':
        return requested
    # Kokoro's CPU path is the conservative Mac baseline. CUDA is preferred on PC.
    return 'cuda' if torch.cuda.is_available() else 'cpu'


class KokoroEngine:
    def __init__(self, args):
        from kokoro import KModel, KPipeline
        import torch
        from huggingface_hub import hf_hub_download, try_to_load_from_cache
        self.args = args
        if not args.voice.startswith(('a', 'b')):
            raise ValueError('This prototype supports American and British English Kokoro voices.')
        repo = args.model or 'hexgrad/Kokoro-82M'
        def local_first(filename):
            cached = try_to_load_from_cache(repo, filename)
            if isinstance(cached, str):
                return cached
            if getattr(args, 'on_download', None):
                args.on_download(filename)
            return hf_hub_download(repo_id=repo, filename=filename)
        # Cached voices must not wait on a network metadata check to work offline.
        model = KModel(repo_id=repo, config=local_first('config.json'),
                       model=local_first(KModel.MODEL_NAMES.get(repo, 'kokoro-v1_0.pth')))
        self.device = device_for(args.device)
        self.device_name = torch.cuda.get_device_name(0) if self.device == 'cuda' else 'CPU'
        model = model.to(self.device).eval()
        self.pipeline = KPipeline(lang_code=args.voice[0], model=model, repo_id=repo)
        self.pipeline.voices[args.voice] = self.pipeline.load_single_voice(local_first(f'voices/{args.voice}.pt'))

    def synthesize(self, chunk, output):
        import numpy as np
        import soundfile as sf
        spans = []
        audio = []
        samples = 0
        for result in self.pipeline(chunk['text'], voice=self.args.voice, speed=self.args.speed, split_pattern=None):
            segment = result.audio.detach().cpu().numpy().reshape(-1)
            for token in result.tokens or []:
                spans.append({'text': token.text,
                              'startMs': None if token.start_ts is None else samples / 24 + token.start_ts * 1000,
                              'endMs': None if token.end_ts is None else samples / 24 + token.end_ts * 1000})
            audio.append(segment)
            samples += len(segment)
        if not audio:
            raise ValueError('Kokoro produced no speech for this passage.')
        sf.write(str(output), np.concatenate(audio), 24000, subtype='PCM_16')
        return [t['w'] for t in chunk['tokens']], spans


class QwenEngine:
    def __init__(self, args):
        import torch
        from qwen_tts import Qwen3TTSModel
        self.args = args
        self.device = device_for(args.device)
        if self.device == 'mps':
            raise ValueError('The Qwen adapter currently targets CUDA or CPU. Use Kokoro on this Mac.')
        self.model = Qwen3TTSModel.from_pretrained(args.model or 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
            device_map=self.device, dtype=torch.bfloat16 if self.device == 'cuda' else torch.float32,
            attn_implementation='sdpa')

    def synthesize(self, chunk, output):
        import soundfile as sf
        expected = [spoken_token(t['w']) for t in chunk['tokens']]
        speech = ''.join(w + ('' if t['g'] else ' ') for w, t in zip(expected, chunk['tokens'])).strip()
        audio, sample_rate = self.model.generate_custom_voice(text=speech, language='English', speaker=self.args.voice)
        sf.write(str(output), audio[0], sample_rate, subtype='PCM_16')
        return expected, None


class QwenAligner:
    def __init__(self, args):
        import torch
        from qwen_asr import Qwen3ForcedAligner
        device = device_for(args.device)
        self.model = Qwen3ForcedAligner.from_pretrained('Qwen/Qwen3-ForcedAligner-0.6B',
            device_map=device, dtype=torch.bfloat16 if device == 'cuda' else torch.float32)

    def align(self, audio, text):
        results = self.model.align(audio=str(audio), text=text, language='English')
        return [{'text': item.text, 'startMs': item.start_time * 1000, 'endMs': item.end_time * 1000} for item in results[0]]
