"""One-time Windows/CUDA setup. Installs into the repository's local environment."""
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def run(command, env=None):
    print('\n> ' + subprocess.list2cmdline([str(part) for part in command]), flush=True)
    subprocess.run([str(part) for part in command], cwd=ROOT, env=env, check=True)


def main():
    if sys.platform != 'win32' or sys.version_info[:2] != (3, 12):
        raise SystemExit('Run this setup on Windows with Python 3.12.')
    python = ROOT / '.venv-kokoro' / 'Scripts' / 'python.exe'
    if not python.exists():
        run([sys.executable, '-m', 'venv', ROOT / '.venv-kokoro'])
    run([python, '-m', 'pip', 'install', '--upgrade', 'pip'])
    # Official PyTorch CUDA 12.4 Windows wheel; the CUDA toolkit is not built here.
    run([python, '-m', 'pip', 'install', '--upgrade', 'torch==2.6.0', '--index-url', 'https://download.pytorch.org/whl/cu124'])
    run([python, '-m', 'pip', 'install', '-r', ROOT / 'tools/audiobook/requirements-kokoro.txt'])
    env = os.environ.copy()
    env['HF_HOME'] = str(ROOT / '.studio-models')
    env.setdefault('HF_HUB_DISABLE_XET', '1')
    run([python, ROOT / 'tools/audiobook/check_environment.py', '--require-cuda'], env=env)
    run([python, '-m', 'spacy', 'download', 'en_core_web_sm'], env=env)
    run([python, ROOT / 'tools/audiobook/check_environment.py', '--require-cuda', '--warmup'], env=env)
    print('\nReady: the GPU and a real timed narration sample have been checked.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(f'Setup stopped because a command failed (exit {error.returncode}).')
