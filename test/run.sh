# Runs inside a container: typecheck against Pi's types, then the end-to-end test.
set -eu
PI_VERSION="${PI_VERSION:-1.1.0}"
npm i -g --no-audit --no-fund "@earendil-works/pi-coding-agent@$PI_VERSION" > /tmp/npm-pi.log 2>&1
echo "pi $(pi --version)"

mkdir -p /tmp/types
cp /ext/index.ts /ext/tsconfig.json /tmp/types/
(cd /tmp/types && npm i --no-save --no-audit --no-fund typescript@5 @types/node@24 "@earendil-works/pi-coding-agent@$PI_VERSION" > /tmp/npm-types.log 2>&1)
(cd /tmp/types && npx tsc -p tsconfig.json) && echo "typecheck ok"

bash /ext/test/local.sh
