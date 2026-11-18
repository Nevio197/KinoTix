"""Fill unused native imports in Samsung Emscripten's JS socket fallback."""

from collections import Counter
from pathlib import Path
import argparse
import re


NATIVE_IMPORTS = Counter({name: 1 for name in (
    'accept', 'bind', 'close', 'connect', 'getpeername', 'getsockname',
    'getsockopt', 'listen', 'poll', 'recv', 'recvfrom', 'recvmsg', 'select',
    'send', 'sendmsg', 'sendto', 'setsockopt', 'shutdown', 'socket',
)})
UNRESOLVED = re.compile(r'("_wasm_([a-z]+)":)__wasm_\2(?=[,}])')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('worker', type=Path)
    args = parser.parse_args()
    source = args.worker.read_text(encoding='utf-8')
    found = Counter(match[2] for match in UNRESOLVED.finditer(source))
    if found != NATIVE_IMPORTS:
        parser.exit(1, 'Unexpected native socket imports in Samsung SDK output.\n')
    source = UNRESOLVED.sub(r'\1function(){return -38}', source)
    args.worker.write_text(source, encoding='utf-8')


if __name__ == '__main__':
    main()
