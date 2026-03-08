#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIBUSB_SRC_DIR="$ROOT_DIR/ref/libusb-1.0.29"
LIBUSB_BUILD_DIR="$LIBUSB_SRC_DIR/build-wasm"
LIBUSB_STATIC_LIB="$LIBUSB_BUILD_DIR/libusb/.libs/libusb-1.0.a"
WASM_CMAKE_SRC_DIR="$ROOT_DIR/.wasm-cmake"
WASM_BUILD_DIR="$ROOT_DIR/build-wasm"
DIST_DIR="$ROOT_DIR/dist"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

cpu_count() {
  if command -v sysctl >/dev/null 2>&1; then
    sysctl -n hw.ncpu
  elif command -v nproc >/dev/null 2>&1; then
    nproc
  else
    echo 4
  fi
}

require_cmd emcc
require_cmd emcmake
require_cmd emconfigure
require_cmd emmake
require_cmd cmake

if [[ ! -d "$LIBUSB_SRC_DIR" ]]; then
  echo "libusb source directory not found: $LIBUSB_SRC_DIR" >&2
  exit 1
fi

mkdir -p "$DIST_DIR" "$LIBUSB_BUILD_DIR" "$WASM_CMAKE_SRC_DIR" "$WASM_BUILD_DIR"

if [[ ! -f "$LIBUSB_STATIC_LIB" ]]; then
  pushd "$LIBUSB_BUILD_DIR" >/dev/null
  emconfigure "$LIBUSB_SRC_DIR/configure" \
    --host=wasm32-unknown-emscripten \
    --disable-shared \
    --enable-static \
    --disable-udev
  emmake make -j"$(cpu_count)"
  popd >/dev/null
fi

cp "$ROOT_DIR/CMakeLists.wasm.txt" "$WASM_CMAKE_SRC_DIR/CMakeLists.txt"

emcmake cmake \
  -S "$WASM_CMAKE_SRC_DIR" \
  -B "$WASM_BUILD_DIR" \
  -DRKTOOL_ROOT="$ROOT_DIR" \
  -DLIBUSB_STATIC_LIB="$LIBUSB_STATIC_LIB" \
  -DCMAKE_BUILD_TYPE=Release

cmake --build "$WASM_BUILD_DIR" --parallel "$(cpu_count)"

echo "WASM build complete. Outputs are in: $DIST_DIR"
