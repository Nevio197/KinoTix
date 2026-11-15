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

jsoup="$cache/jsoup-1.24.1.jar"
jsoup_sha=fabbb4aaf7fb5340aed0613826ecd110427999d765d8e0367cedde2950d7097c
verify_jsoup() {
    printf '%s  %s\n' "$jsoup_sha" "$1" | shasum -a 256 -c --status
}
if [[ ! -f "$jsoup" ]]; then
    curl --proto '=https' --fail --silent --show-error --location --retry 2 \
        'https://repo.maven.apache.org/maven2/org/jsoup/jsoup/1.24.1/jsoup-1.24.1.jar' -o "$work/jsoup.jar"
    verify_jsoup "$work/jsoup.jar"
    mv "$work/jsoup.jar" "$jsoup"
fi
verify_jsoup "$jsoup"

mkdir -p "$work/generated" "$work/classes" "$work/dex" "$work/assets/licenses"
unzip -p "$jsoup" META-INF/jsoup/LICENSE > "$work/assets/licenses/jsoup.txt"
"$tools/aapt2" compile --dir "$src/res" -o "$work/resources.zip"
"$tools/aapt2" link -I "$platform" --manifest "$src/AndroidManifest.xml" \
    --java "$work/generated" -A "$work/assets" --min-sdk-version 25 --target-sdk-version 34 \
    --version-code "$version_code" --version-name "$version" -o "$work/unsigned.apk" "$work/resources.zip"
sources=()
while IFS= read -r -d '' filename; do sources+=("$filename"); done < <(find "$src/java" "$work/generated" -name '*.java' -print0)
"$jdk/bin/javac" --release 8 -encoding UTF-8 -classpath "$platform:$jsoup" -d "$work/classes" "${sources[@]}"
"$jdk/bin/jar" cf "$work/app.jar" -C "$work/classes" .
JAVA_HOME="$jdk" "$tools/d8" --lib "$platform" --min-api 25 --output "$work/dex" "$work/app.jar" "$jsoup"
for dex in "$work/dex/"*.dex; do zip -q -j "$work/unsigned.apk" "$dex"; done
"$tools/zipalign" -f 4 "$work/unsigned.apk" "$work/aligned.apk"
signer=(--ks "$store" --ks-key-alias "$alias" --ks-pass "$store_pass")
if [[ -n "$key_pass" ]]; then signer+=(--key-pass "$key_pass"); fi
JAVA_HOME="$jdk" "$tools/apksigner" sign "${signer[@]}" --out "$work/signed.apk" "$work/aligned.apk"
JAVA_HOME="$jdk" "$tools/apksigner" verify --min-sdk-version 25 "$work/signed.apk"
mv "$work/signed.apk" "$out/$name"
printf '%s\n' "$out/$name"
