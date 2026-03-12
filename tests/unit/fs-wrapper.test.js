import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFsWrapper, ensureRuntimeDirs } from '../../src/fs-wrapper.js';
import { NodeBlob } from '../../src/node-blob.js';

function createMockFs() {
  const dirs = new Set(['/']);
  const mounts = new Map();
  const files = new Map();

  return {
    dirs,
    mounts,
    files,
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
    writeFile(pathname, content) {
      files.set(pathname, content);
    },
  };
}

async function withTempNodeBlob(fileName, callback) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rktool-fs-wrapper-'));
  const filePath = path.join(tempDir, fileName);
  await fs.writeFile(filePath, Buffer.from([1, 2, 3, 4]));
  const blob = new NodeBlob(filePath);

  try {
    return await callback(blob, filePath);
  } finally {
    blob.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
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

  const wrapper = await createFsWrapper(moduleInstance, { runtime: 'browser' });
  const fakeFile = { name: 'firmware.bin' };
  const { virtualPath: mountedPath, mountPoint } = await wrapper.mountFile('firmware', fakeFile);

  assert.match(mountedPath, /^\/tmp\/mounts\/.+\/firmware\.bin$/);
  const mountRecord = FS.mounts.get(mountPoint);
  assert.ok(mountRecord);
  assert.equal(mountRecord.type.kind, 'WORKERFS');
  assert.equal(Array.isArray(mountRecord.options.files), true);
  assert.equal(mountRecord.options.files[0], fakeFile);
});

test('mountFile uses WORKERFS from FS.filesystems fallback', async () => {
  const FS = createMockFs();
  FS.filesystems = {
    WORKERFS: { kind: 'WORKERFS' },
  };
  const moduleInstance = {
    FS,
  };

  const wrapper = await createFsWrapper(moduleInstance, { runtime: 'browser' });
  const fakeFile = { name: 'firmware.bin' };
  const { virtualPath: mountedPath, mountPoint } = await wrapper.mountFile('firmware', fakeFile);

  assert.match(mountedPath, /^\/tmp\/mounts\/.+\/firmware\.bin$/);
  const mountRecord = FS.mounts.get(mountPoint);
  assert.ok(mountRecord);
  assert.equal(mountRecord.type.kind, 'WORKERFS');
  assert.equal(Array.isArray(mountRecord.options.files), true);
  assert.equal(mountRecord.options.files[0], fakeFile);
});

test('mountFile with gunzip uses DECWORKERFS in browser runtime', async () => {
  const FS = createMockFs();
  const moduleInstance = {
    FS,
    WORKERFS: { kind: 'WORKERFS' },
  };

  const wrapper = await createFsWrapper(moduleInstance, { runtime: 'browser' });
  const fakeFile = {
    name: 'firmware.img.gz',
    size: 128,
    slice() {
      return this;
    },
  };

  const { virtualPath: mountedPath, mountPoint } = await wrapper.mountFile('firmware', fakeFile, true);

  assert.match(mountedPath, /^\/tmp\/mounts\/.+\/firmware\.img$/);
  const mountRecord = FS.mounts.get(mountPoint);
  assert.ok(mountRecord);
  assert.equal(mountRecord.type.kind, 'WORKERFS');
  assert.ok(mountRecord.type.mount);
  assert.equal(mountRecord.options.files[0].name, 'firmware.img.gz');
  assert.equal(mountRecord.options.files[0].virtualName, 'firmware.img');
  assert.equal(mountRecord.options.files[0].decFormat, 'gzip');
  assert.equal(mountRecord.options.files[0].data, fakeFile);
});

test('mountFile with gunzip supports xz suffix in browser runtime', async () => {
  const FS = createMockFs();
  const moduleInstance = {
    FS,
    WORKERFS: { kind: 'WORKERFS' },
  };

  const wrapper = await createFsWrapper(moduleInstance, { runtime: 'browser' });
  const fakeFile = {
    name: 'firmware.img.xz',
    size: 128,
    slice() {
      return this;
    },
  };

  const { virtualPath: mountedPath, mountPoint } = await wrapper.mountFile('firmware', fakeFile, true);

  assert.match(mountedPath, /^\/tmp\/mounts\/.+\/firmware\.img$/);
  const mountRecord = FS.mounts.get(mountPoint);
  assert.ok(mountRecord);
  assert.equal(mountRecord.type.kind, 'WORKERFS');
  assert.ok(mountRecord.type.mount);
  assert.equal(mountRecord.options.files[0].name, 'firmware.img.xz');
  assert.equal(mountRecord.options.files[0].virtualName, 'firmware.img');
  assert.equal(mountRecord.options.files[0].decFormat, 'xz');
  assert.equal(mountRecord.options.files[0].data, fakeFile);
});

test('mountFile with gunzip prefers fallback suffix when source name is unsupported', async () => {
  const FS = createMockFs();
  const moduleInstance = {
    FS,
    WORKERFS: { kind: 'WORKERFS' },
  };

  const wrapper = await createFsWrapper(moduleInstance, { runtime: 'browser' });
  const fakeFile = {
    name: 'firmware.img.gz-withmeta',
    size: 128,
    slice() {
      return this;
    },
  };

  const { virtualPath: mountedPath, mountPoint } = await wrapper.mountFile('firmware.img.gz', fakeFile, true);

  assert.match(mountedPath, /^\/tmp\/mounts\/.+\/firmware\.img$/);
  const mountRecord = FS.mounts.get(mountPoint);
  assert.ok(mountRecord);
  assert.equal(mountRecord.options.files[0].name, 'firmware.img.gz');
  assert.equal(mountRecord.options.files[0].virtualName, 'firmware.img');
  assert.equal(mountRecord.options.files[0].decFormat, 'gzip');
});

test('mountFile with gunzip rejects invalid browser source', async () => {
  const FS = createMockFs();
  const moduleInstance = {
    FS,
    WORKERFS: { kind: 'WORKERFS' },
  };

  const wrapper = await createFsWrapper(moduleInstance, { runtime: 'browser' });

  await assert.rejects(
    () => wrapper.mountFile('firmware', { name: 'firmware.img.gz' }, true),
    /gunzip requires a File\/Blob-like source object with slice\(\)/
  );
});

test('mountFile uses NODEFS in node runtime', async () => {
  const FS = createMockFs();
  const moduleInstance = {
    FS,
    NODEFS: { kind: 'NODEFS' },
    WORKERFS: { kind: 'WORKERFS' },
  };

  const wrapper = await createFsWrapper(moduleInstance, { runtime: 'node' });
  await withTempNodeBlob('test-update.img', async (blob) => {
    const { virtualPath: mountedPath, mountPoint } = await wrapper.mountFile('image', blob);

    assert.match(mountedPath, /^\/tmp\/mounts\/.+\/test-update\.img$/);
    const mountRecord = FS.mounts.get(mountPoint);
    assert.ok(mountRecord);
    assert.equal(mountRecord.type.kind, 'WORKERFS');
    assert.equal(mountRecord.options.files[0], blob);
    assert.equal(mountRecord.options.files[0].name, 'test-update.img');
  });
});

test('mountFile uses NODEFS from FS.filesystems fallback', async () => {
  const FS = createMockFs();
  FS.filesystems = {
    NODEFS: { kind: 'NODEFS' },
    WORKERFS: { kind: 'WORKERFS' },
  };
  const moduleInstance = {
    FS,
  };

  const wrapper = await createFsWrapper(moduleInstance, { runtime: 'node' });
  await withTempNodeBlob('test-update.img', async (blob) => {
    const { virtualPath: mountedPath, mountPoint } = await wrapper.mountFile('image', blob);

    assert.match(mountedPath, /^\/tmp\/mounts\/.+\/test-update\.img$/);
    const mountRecord = FS.mounts.get(mountPoint);
    assert.ok(mountRecord);
    assert.equal(mountRecord.type.kind, 'WORKERFS');
    assert.equal(mountRecord.options.files[0], blob);
    assert.equal(mountRecord.options.files[0].name, 'test-update.img');
  });
});

test('mountFile with gunzip uses DECWORKERFS in node runtime', async () => {
  const FS = createMockFs();
  const moduleInstance = {
    FS,
    NODEFS: { kind: 'NODEFS' },
    WORKERFS: { kind: 'WORKERFS' },
  };

  const wrapper = await createFsWrapper(moduleInstance, { runtime: 'node' });
  await withTempNodeBlob('test-update.img.gz', async (blob) => {
    const { virtualPath: mountedPath, mountPoint } = await wrapper.mountFile('image', blob, true);

    assert.match(mountedPath, /^\/tmp\/mounts\/.+\/test-update\.img$/);
    const mountRecord = FS.mounts.get(mountPoint);
    assert.ok(mountRecord);
    assert.equal(mountRecord.type.kind, 'WORKERFS');
    assert.ok(mountRecord.type.mount);
    assert.equal(mountRecord.options.files[0].name, 'test-update.img.gz');
    assert.equal(mountRecord.options.files[0].virtualName, 'test-update.img');
    assert.equal(mountRecord.options.files[0].decFormat, 'gzip');
    assert.equal(mountRecord.options.files[0].data, blob);
  });
});

test('mountFile throws when WORKERFS mount fails', async () => {
  const FS = createMockFs();
  FS.filesystems = {
    WORKERFS: { kind: 'WORKERFS' },
  };

  let mountCallCount = 0;
  FS.mount = () => {
    mountCallCount++;
    throw new Error('WORKERFS requires worker');
  };

  const moduleInstance = {
    FS,
  };

  const wrapper = await createFsWrapper(moduleInstance, { runtime: 'browser' });
  const fakeFile = {
    name: 'firmware.bin',
  };

  await assert.rejects(
    () => wrapper.mountFile('firmware', fakeFile),
    /Failed to mount source with WORKERFS: WORKERFS requires worker/
  );

  assert.equal(mountCallCount, 1);
});

test('mountFile throws when WORKERFS is unavailable in browser runtime', async () => {
  const FS = createMockFs();
  const moduleInstance = {
    FS,
  };

  const wrapper = await createFsWrapper(moduleInstance, { runtime: 'browser' });
  const fakeFile = { name: 'firmware.bin' };

  await assert.rejects(
    () => wrapper.mountFile('firmware', fakeFile),
    /WORKERFS is required for file mapping/
  );
});

test('createFsWrapper throws when WORKERFS is unavailable in node runtime', async () => {
  const FS = createMockFs();
  const moduleInstance = {
    FS,
  };

  await assert.rejects(
    () => createFsWrapper(moduleInstance, { runtime: 'node' }),
    /WORKERFS is required for file mapping/
  );
});
