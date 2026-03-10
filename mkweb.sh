npm run build:wasm:release || exit 1

rm -rf webarchive/web
mkdir -p webarchive
cp -a examples/browser webarchive/web
rm -f webarchive/web/dist webarchive/web/src
mkdir -p webarchive/web/dist
cp -a dist/*.js webarchive/web/dist/
cp -a dist/*.wasm webarchive/web/dist/
cp -a src webarchive/web/

xattr -cr webarchive/web 2>/dev/null || true

TAR=tar

which gtar >/dev/null 2>&1 && TAR=gtar

$TAR -C webarchive/web -czf webarchive/webarchive.tar.gz .
