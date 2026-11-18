#!/bin/sh
set -eu

if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo 'Usage: ./build-transport.sh /path/to/cacert.pem' >&2
  exit 2
fi

ca_bundle="$(CDPATH= cd "$(dirname "$1")" && pwd)/$(basename "$1")"
root="$(CDPATH= cd "$(dirname "$0")" && pwd)"
emcc="${EMCC:-emcc}"
python="${PYTHON:-python3}"

if ! command -v "$emcc" >/dev/null 2>&1; then
  echo 'Set up the Samsung Emscripten SDK or point EMCC to its emcc.py.' >&2
  exit 2
fi

mkdir -p "$root/build"
staging="$(mktemp -d "$root/build/transport.XXXXXXXX")"
trap '"$python" -c "import shutil,sys; shutil.rmtree(sys.argv[1],ignore_errors=True)" "$staging"' EXIT
trap 'exit 1' HUP INT TERM

export EMCC_CFLAGS="${EMCC_CFLAGS:+$EMCC_CFLAGS }-s SOCKET_HOST_BINDINGS=0"
case "$emcc" in
  *.py) set -- "$python" "$emcc" ;;
  *) set -- "$emcc" ;;
esac
"$@" "$root/net_fetch.c" -O2 -o "$staging/tizen-fetch.js" \
  -s ENVIRONMENT=worker -s ENVIRONMENT_MAY_BE_TIZEN=1 \
  -s SOCKET_HOST_BINDINGS=0 -s USE_CURL=1 -s NO_EXIT_RUNTIME=1 \
  -s ALLOW_MEMORY_GROWTH=1 -s EXPORTED_RUNTIME_METHODS='["ccall"]' \
  --preload-file "$ca_bundle@/cacert.pem" --post-js "$root/worker-bridge.js"

"$python" "$root/patch-worker.py" "$staging/tizen-fetch.js"
test -s "$staging/tizen-fetch.wasm"
test -s "$staging/tizen-fetch.data"
mkdir -p "$root/build/transport"
for asset in tizen-fetch.js tizen-fetch.wasm tizen-fetch.data; do
  mv "$staging/$asset" "$root/build/transport/$asset"
done
