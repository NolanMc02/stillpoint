"""Check the actual speech device, encoder, and optional timed voice warm-up."""
import argparse
import json
import tempfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--require-cuda', action='store_true')
    parser.add_argument('--warmup', action='store_true')
    args = parser.parse_args()
    import torch
    import imageio_ffmpeg
    from engines import device_for
    device = device_for('auto')
    info = {'pythonTorch': torch.__version__, 'cudaAvailable': torch.cuda.is_available(),
            'device': device, 'deviceName': torch.cuda.get_device_name(0) if device == 'cuda' else 'CPU',
            'ffmpeg': imageio_ffmpeg.get_ffmpeg_exe()}
    print(json.dumps(info, indent=2), flush=True)
    if args.require_cuda and device != 'cuda':
        raise SystemExit('CUDA is not available. Update the NVIDIA driver and check the PyTorch CUDA installation. Studio would otherwise use the CPU.')
    if args.warmup:
        from generate import digest, generate
        tokens = [{'w': word, 'g': 0} for word in 'Your local narrator is ready.'.split()]
        block = {'sid': 'setup:0', 'tokens': tokens}
        job = {'format': 'stillpoint-narration-job', 'version': 1, 'tokenizer': 'stillpoint-v1',
               'book': {'title': 'Setup check', 'author': ''}, 'blocks': [block],
               'textHash': digest([[block['sid'], [[t['w'], t['g']] for t in tokens]]])}
        config = argparse.Namespace(engine='kokoro', voice='af_heart', model=None, speed=1,
                                    device=device, max_chars=300, audio_format='m4a')
        with tempfile.TemporaryDirectory() as directory:
            result = generate(job, Path(directory) / 'setup.zip', config)
            if sum(len(c['words']) for c in result['clips']) != len(tokens):
                raise RuntimeError('Voice warm-up did not produce complete word timings.')
        print('PASS real narration, per-word timings, and M4A encoding', flush=True)


if __name__ == '__main__':
    main()
