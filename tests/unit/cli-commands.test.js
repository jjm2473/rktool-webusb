import test from 'node:test';
import assert from 'node:assert/strict';
import { createRKDevelopToolWrapper } from '../../src/rkdeveloptool-wrapper.js';

function createMockEmscriptenModule() {
  const dirs = new Set(['/']);
  const mounts = new Map();
  const streamOps = {
    write(stream, buffer, offset, length) {
      return length;
    },
  };

  return {
    dirs,
    mounts,
    FS: {
      filesystems: {
        MEMFS: {
          stream_ops: streamOps,
        },
      },
      mkdir(pathname) {
        if (dirs.has(pathname)) {
          throw new Error('File exists');
        }
        dirs.add(pathname);
      },
      chdir(pathname) {
        if (!dirs.has(pathname)) {
          throw new Error('No such directory');
        }
      },
      mount(type, options, mountPoint) {
        mounts.set(mountPoint, { type, options });
      },
      unmount(mountPoint) {
        mounts.delete(mountPoint);
      },
    },
    NODEFS: { kind: 'NODEFS' },
    WORKERFS: { kind: 'WORKERFS' },
    streamOps,
  };
}

test('runCommand executes and captures stdout/stderr', async () => {
  let capturedArgv = [];
  const logs = [];

  const wrapper = await createRKDevelopToolWrapper({
    runtime: 'node',
    onLogWrite: (event) => logs.push(event),
    moduleFactory: async (moduleOptions) => {
      const mockModule = createMockEmscriptenModule();
      mockModule.callMain = (argv) => {
        capturedArgv = argv;
        moduleOptions.print('stdout-line');
        moduleOptions.printErr('stderr-line');

        const bytes = new TextEncoder().encode('log-line');
        mockModule.streamOps.write(
          { path: '/tmp/log/log2026-03-08.txt' },
          bytes,
          0,
          bytes.length,
          0,
          false
        );
      };
      return mockModule;
    },
  });

  const result = await wrapper.runCommand(['ld']);
  assert.deepEqual(capturedArgv, ['ld']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /stdout-line/);
  assert.match(result.stderr, /stderr-line/);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].path, '/tmp/log/log2026-03-08.txt');
});

test('runCommand replaces token with mounted path', async () => {
  let capturedArgv = [];

  const wrapper = await createRKDevelopToolWrapper({
    runtime: 'node',
    moduleFactory: async () => {
      const mockModule = createMockEmscriptenModule();
      mockModule.callMain = (argv) => {
        capturedArgv = argv;
      };
      return mockModule;
    },
  });

  await wrapper.runCommand(['db', '$FILE'], {
    fileSource: '/tmp/loader.bin',
    replaceToken: '$FILE',
    fileName: 'loader.bin',
  });

  assert.equal(capturedArgv[0], 'db');
  assert.match(capturedArgv[1], /^\/tmp\/mounts\/.+\/loader\.bin$/);
});
