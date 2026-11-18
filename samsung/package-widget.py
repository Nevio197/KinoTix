"""Package an allowlisted Tizen widget and optionally sign it with Tizen Studio."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import urlsplit
from xml.etree import ElementTree
from zipfile import BadZipFile, ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parent
WIDGET_FILES = ('config.xml', 'index.html', 'style.css', 'app.js', 'icon.png',
                'provider.js', 'formats.js', 'account.js', 'library.js', 'transport.js',
                'qrcode.js', 'supabase.json', 'font.woff2')
TRANSPORT_FILES = ('tizen-fetch.js', 'tizen-fetch.wasm', 'tizen-fetch.data')
SIGNATURE_FILES = ('author-signature.xml', 'signature1.xml')
LICENSE_FILES = ('emscripten.txt', 'curl.txt', 'openssl.txt', 'zlib.txt', 'musl.txt',
                 'libcxx.txt', 'libcxxabi.txt', 'mozilla-ca.txt', 'qrcode.txt', 'components.txt', 'inter.txt')


def account_configuration():
    path = Path(os.environ.get('KINOTIX_SAMSUNG_ACCOUNT_CONFIG', ROOT.parent / 'app' / 'supabase.json'))
    if not path.exists():
        return b'{}'
    value = json.loads(path.read_text())
    address = urlsplit(value.get('url', ''))
    key = value.get('publishableKey', '')
    if (address.scheme != 'https' or not re.fullmatch(r'[a-z0-9-]+\.supabase\.co', address.hostname or '')
            or address.username or address.password or address.port or address.path not in ('', '/')
            or address.query or address.fragment or not isinstance(key, str)
            or not re.fullmatch(r'sb_publishable_[\w-]+', key)):
        raise ValueError('Expected a Supabase HTTPS origin and public Publishable Key.')
    return json.dumps({'url': 'https://' + address.hostname, 'publishableKey': key}).encode()


def verify(path, files, signatures=()):
    with ZipFile(path) as archive:
        records = archive.infolist()
        entries = [record.filename for record in records if not record.is_dir()]
        expected = set(files).union(signatures)
        if len(entries) != len(expected) or set(entries) != expected:
            raise ValueError('Unexpected widget archive contents.')
        if any(record.is_dir() and record.filename != 'licenses/' for record in records):
            raise ValueError('Unexpected widget archive directory.')
        for name, data in files.items():
            if archive.read(name) != data:
                raise ValueError(f'Widget entry changed during packing: {name}')
        for name in signatures:
            ElementTree.fromstring(archive.read(name))


def package(output, profile, tizen):
    sources = {name: ROOT / 'widget' / name for name in WIDGET_FILES}
    sources.update({name: ROOT / 'build' / 'transport' / name for name in TRANSPORT_FILES})
    sources.update({'licenses/' + name: ROOT / 'licenses' / name for name in LICENSE_FILES})
    files = {name: path.read_bytes() for name, path in sources.items() if name != 'supabase.json'}
    files['supabase.json'] = account_configuration()
    if not all(files.values()):
        raise ValueError('A widget or transport file is empty.')

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent, prefix='.kinotix-tizen-') as temporary:
        staging = Path(temporary)
        unsigned = staging / output.name
        with ZipFile(unsigned, 'w', compression=ZIP_DEFLATED) as archive:
            for name, data in files.items():
                archive.writestr(name, data)
        verify(unsigned, files)

        widget = unsigned
        if profile:
            signed = staging / 'signed'
            signed.mkdir()
            subprocess.run([tizen, 'package', '-t', 'wgt', '-s', profile,
                            '-o', str(signed), '--', str(unsigned)], check=True)
            widget = signed / unsigned.name
            verify(widget, files, SIGNATURE_FILES)
        widget.chmod(0o600)
        widget.replace(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--unsigned', action='store_true', help='archive without signatures')
    mode.add_argument('--profile', help='local Tizen author/distributor profile name')
    parser.add_argument('--tizen', default='tizen', help='Tizen Studio CLI executable')
    parser.add_argument('output', type=Path, help='destination ending in .wgt')
    args = parser.parse_args()
    if args.output.suffix != '.wgt':
        parser.error('the destination must end in .wgt')
    if args.profile is not None and not args.profile.strip():
        parser.error('the signing profile name must not be empty')
    try:
        package(args.output.resolve(), args.profile, args.tizen)
    except (OSError, ValueError, BadZipFile, ElementTree.ParseError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Widget packaging failed: {error}\n')
    print(f'Widget archive verified: {args.output}')


if __name__ == '__main__':
    main()
