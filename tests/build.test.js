import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

function hasCommand(command) {
  const result = spawnSync('bash', ['-lc', `command -v ${command}`], {
    cwd: projectRoot,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  return result.status === 0;
}

test('wasm build produces dist artifacts', { skip: !hasCommand('emcc') || !hasCommand('emcmake') }, () => {
  const buildResult = spawnSync('bash', ['./build_wasm.sh'], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  assert.equal(buildResult.status, 0, 'build_wasm.sh should exit with code 0');

  const wasmPath = path.join(projectRoot, 'dist', 'rkdeveloptool.wasm');
  const jsPath = path.join(projectRoot, 'dist', 'rkdeveloptool.js');

  assert.equal(fs.existsSync(wasmPath), true, 'dist/rkdeveloptool.wasm should exist');
  assert.equal(fs.existsSync(jsPath), true, 'dist/rkdeveloptool.js should exist');

  const wasmStat = fs.statSync(wasmPath);
  assert.ok(wasmStat.size > 0, 'wasm file must be non-empty');
  assert.ok(wasmStat.size < 5 * 1024 * 1024, 'wasm file should be smaller than 5MB');

  if (hasCommand('wasm-objdump')) {
    const dump = spawnSync('wasm-objdump', ['-x', wasmPath], {
      cwd: projectRoot,
      stdio: 'pipe',
      encoding: 'utf8',
    });

    assert.equal(dump.status, 0, 'wasm-objdump should run successfully');
    assert.match(dump.stdout, /_main/, 'wasm should export _main symbol');
  }
});
