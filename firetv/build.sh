#!/usr/bin/env bash
set -euo pipefail

project=$(cd -- "$(dirname -- "$0")/.." && pwd)
src="$project/firetv/app/src/main"
sdk=${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}
tools="$sdk/build-tools/35.0.0"
platform="$sdk/platforms/android-34/android.jar"
jdk=${JAVA_HOME:-}
if [[ -z "$jdk" && -x /usr/libexec/java_home ]]; then jdk=$(/usr/libexec/java_home -v 17 2>/dev/null || true); fi
if [[ ! -r "$platform" || ! -x "$tools/aapt2" || ! -x "$jdk/bin/javac" || -z "$sdk" || -z "$jdk" ]]; then
    echo 'Benötigt werden JDK 17, Android Platform 34 und Build-Tools 35.0.0 (JAVA_HOME und ANDROID_SDK_ROOT).' >&2
    exit 1
fi

version=$(python3 - "$project/firetv/version.txt" <<'PY'
import re, sys
with open(sys.argv[1]) as file:
    version = file.read().strip()
if not re.fullmatch(r'(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})', version):
    raise SystemExit('Für Fire TV wird eine stabile Version im Format X.Y.Z benötigt.')
print(version)
PY
)
IFS=. read -r major minor patch <<< "$version"
version_code=$((major * 1000000 + minor * 1000 + patch))
if [[ "$version_code" -eq 0 ]]; then echo 'Fire-TV-Versionscode muss größer als null sein.' >&2; exit 1; fi

out=${KINOTIX_FIRETV_OUTPUT_DIR:-"$project/dist/firetv"}
cache=${KINOTIX_FIRETV_CACHE_DIR:-"$project/dist/firetv-cache"}
mkdir -p "$out" "$cache"
work=$(mktemp -d "$out/.build.XXXXXX")
trap 'rm -rf -- "$work"' EXIT

if [[ "$#" -eq 1 && "$1" == --test ]]; then
    signing=${KINOTIX_FIRETV_TEST_SIGNING_DIR:-"$project/dist/firetv-test-signing"}
    (umask 077; mkdir -p "$signing")
    store="$signing/kinotix-test.p12"
    alias=kinotix-test
    if [[ ! -e "$store" ]]; then
        (umask 077; openssl rand -hex 24 > "$signing/password"; \
            "$jdk/bin/keytool" -genkeypair -storetype PKCS12 -keystore "$store" \
            -storepass:file "$signing/password" -alias "$alias" -keyalg RSA -keysize 3072 \
            -validity 10000 -dname 'CN=KinoTix Fire TV Test' >/dev/null)
    fi
    store_pass="file:$signing/password"
    key_pass=''
    name="KinoTix-$version-FireTV-Test.apk"
elif [[ "$#" -eq 0 ]]; then
    store=${KINOTIX_FIRETV_KEYSTORE:?Setze den Pfad zum Fire-TV-Signierschlüssel oder nutze --test.}
    alias=${KINOTIX_FIRETV_KEY_ALIAS:?Setze KINOTIX_FIRETV_KEY_ALIAS.}
    : "${KINOTIX_FIRETV_STORE_PASSWORD:?Setze KINOTIX_FIRETV_STORE_PASSWORD.}"
    : "${KINOTIX_FIRETV_KEY_PASSWORD:?Setze KINOTIX_FIRETV_KEY_PASSWORD.}"
    store_pass=env:KINOTIX_FIRETV_STORE_PASSWORD
    key_pass=env:KINOTIX_FIRETV_KEY_PASSWORD
    name="KinoTix-$version-FireTV.apk"
else
    echo 'Verwendung: firetv/build.sh [--test]' >&2
    exit 1
fi

download_jar() {
    local destination=$1 url=$2 checksum=$3
    local staged="$work/$(basename "$destination")"
    if [[ ! -f "$destination" ]]; then
        curl --proto '=https' --fail --silent --show-error --location --retry 2 "$url" -o "$staged"
        printf '%s  %s\n' "$checksum" "$staged" | shasum -a 256 -c --status
        mv "$staged" "$destination"
    fi
    printf '%s  %s\n' "$checksum" "$destination" | shasum -a 256 -c --status
}
jsoup="$cache/jsoup-1.24.1.jar"
zxing="$cache/zxing-core-3.5.4.jar"
re2j="$cache/re2j-1.8.jar"
download_jar "$jsoup" 'https://repo.maven.apache.org/maven2/org/jsoup/jsoup/1.24.1/jsoup-1.24.1.jar' \
    fabbb4aaf7fb5340aed0613826ecd110427999d765d8e0367cedde2950d7097c
download_jar "$zxing" 'https://repo.maven.apache.org/maven2/com/google/zxing/core/3.5.4/core-3.5.4.jar' \
    71de5d89341b5fcf5dd89da7f44e84d825d0e084cdf3ec77c9abe26b0f0ceb13
download_jar "$re2j" 'https://repo.maven.apache.org/maven2/com/google/re2j/re2j/1.8/re2j-1.8.jar' \
    7b52c72156dd7f98b3237a5b35c1d34fba381b21048c89208913ad80a45dfbd7

mkdir -p "$work/generated" "$work/classes" "$work/dex" "$work/assets/licenses"
unzip -p "$jsoup" META-INF/jsoup/LICENSE > "$work/assets/licenses/jsoup.txt"
cp "$project/firetv/licenses/zxing.txt" "$project/firetv/licenses/zxing-notice.txt" \
    "$project/firetv/licenses/re2j.txt" "$work/assets/licenses/"
account_config=${KINOTIX_FIRETV_ACCOUNT_CONFIG:-"$project/app/supabase.json"}
if [[ -e "$account_config" || -n "${KINOTIX_FIRETV_ACCOUNT_CONFIG:-}" ]]; then
    python3 - "$account_config" "$work/assets/supabase.json" <<'PY'
import json, re, sys
with open(sys.argv[1]) as source:
    value = json.load(source)
url = value.get('url', '')
key = value.get('publishableKey', '')
if not isinstance(url, str) or not re.fullmatch(r'https://[a-z0-9-]+\.supabase\.co/?', url):
    raise SystemExit('Die Konto-Konfiguration braucht eine gültige Supabase-Projektadresse.')
if not isinstance(key, str) or not re.fullmatch(r'sb_publishable_[A-Za-z0-9_-]+', key):
    raise SystemExit('Die Konto-Konfiguration braucht einen öffentlichen Publishable Key.')
with open(sys.argv[2], 'w') as target:
    json.dump({'url': url.rstrip('/'), 'publishableKey': key}, target)
PY
fi
"$tools/aapt2" compile --dir "$src/res" -o "$work/resources.zip"
"$tools/aapt2" link -I "$platform" --manifest "$src/AndroidManifest.xml" \
    --java "$work/generated" -A "$work/assets" --min-sdk-version 25 --target-sdk-version 34 \
    --version-code "$version_code" --version-name "$version" -o "$work/unsigned.apk" "$work/resources.zip"
sources=()
while IFS= read -r -d '' filename; do sources+=("$filename"); done < <(find "$src/java" "$work/generated" -name '*.java' -print0)
"$jdk/bin/javac" --release 8 -encoding UTF-8 -classpath "$platform:$jsoup:$zxing:$re2j" -d "$work/classes" "${sources[@]}"
"$jdk/bin/jar" cf "$work/app.jar" -C "$work/classes" .
JAVA_HOME="$jdk" "$tools/d8" --lib "$platform" --min-api 25 --output "$work/dex" "$work/app.jar" "$jsoup" "$zxing" "$re2j"
for dex in "$work/dex/"*.dex; do zip -q -j "$work/unsigned.apk" "$dex"; done
"$tools/zipalign" -f 4 "$work/unsigned.apk" "$work/aligned.apk"
signer=(--ks "$store" --ks-key-alias "$alias" --ks-pass "$store_pass")
if [[ -n "$key_pass" ]]; then signer+=(--key-pass "$key_pass"); fi
JAVA_HOME="$jdk" "$tools/apksigner" sign "${signer[@]}" --out "$work/signed.apk" "$work/aligned.apk"
JAVA_HOME="$jdk" "$tools/apksigner" verify --min-sdk-version 25 "$work/signed.apk"
mv "$work/signed.apk" "$out/$name"
printf '%s\n' "$out/$name"
