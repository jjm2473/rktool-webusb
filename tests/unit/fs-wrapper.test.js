import test from 'node:test';
import assert from 'node:assert/strict';
import { createFsWrapper, ensureRuntimeDirs } from '../../src/fs-wrapper.js';

function createMockFs() {
  const dirs = new Set(['/']);
  const mounts = new Map();

  return {
    dirs,
    mounts,
    mkdir(pathname) {
      if (dirs.has(pathname)) {
        throw new Error('File exists');
      }
      dirs.add(pathname);
    },
    mount(type, options, mountPoint) {
      mounts.set(mountPoint, { type, options });
    },
    unmount(mountPoint) {
      if (!mounts.has(mountPoint)) {
        throw new Error('not mounted');
      }
      mounts.delete(mountPoint);
    },
  };
}

test('ensureRuntimeDirs creates tmp paths', () => {
  const FS = createMockFs();
  ensureRuntimeDirs(FS);
  assert.equal(FS.dirs.has('/tmp'), true);
  assert.equal(FS.dirs.has('/tmp/log'), true);
  assert.equal(FS.dirs.has('/tmp/mounts'), true);
});

test('mountFile uses WORKERFS in browser runtime', async () => {
  const FS = createMockFs();
  const moduleInstance = {
    FS,
    WORKERFS: { kind: 'WORKERFS' },
  };

  const wrapper = createFsWrapper(moduleInstance, { runtime: 'browser' });
  const fakeFile = { name: 'firmware.bin' };
  const mountedPath = await wrapper.mountFile('firmware', fakeFile);

  assert.match(mountedPath, /^\/tmp\/mounts\/.+\/firmware\.bin$/);
  const mountPoint = mountedPath.slice(0, mountedPath.lastIndexOf('/'));
  const mountRecord = FS.mounts.get(mountPoint);
  assert.ok(mountRecord);
  assert.equal(mountRecord.type.kind, 'WORKERFS');
  assert.equal(Array.isArray(mountRecord.options.files), true);
  assert.equal(mountRecord.options.files[0], fakeFile);
});

test('mountFile uses NODEFS in node runtime', async () => {
  const FS = createMockFs();
  const moduleInstance = {
    FS,
    NODEFS: { kind: 'NODEFS' },
  };

  const wrapper = createFsWrapper(moduleInstance, { runtime: 'node' });
  const mountedPath = await wrapper.mountFile('image', '/tmp/test-update.img');

  assert.match(mountedPath, /^\/tmp\/mounts\/.+\/test-update\.img$/);
  const mountPoint = mountedPath.slice(0, mountedPath.lastIndexOf('/'));
  const mountRecord = FS.mounts.get(mountPoint);
  assert.ok(mountRecord);
  assert.equal(mountRecord.type.kind, 'NODEFS');
  assert.equal(mountRecord.options.root, '/tmp');
});
