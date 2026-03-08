import { createPlatformAdapter } from './platform-adapter.js';

const DEFAULT_MODULE_URL = '../dist/rkdeveloptool.js';
const DEFAULT_WASM_URL = '../dist/rkdeveloptool.wasm';

function ensureDir(FS, dirPath) {
  const dirExists = () => {
    try {
      if (typeof FS.analyzePath === 'function') {
        return FS.analyzePath(dirPath).exists;
      }
      if (typeof FS.stat === 'function' && typeof FS.isDir === 'function') {
        const stat = FS.stat(dirPath);
        return FS.isDir(stat.mode);
      }
    } catch (_error) {
      return false;
    }
    return false;
  };

  if (dirExists()) {
    return;
  }

  try {
    FS.mkdir(dirPath);
  } catch (error) {
    if (!dirExists() && !String(error && error.message).includes('File exists')) {
      throw error;
    }
  }
}

function normalizeSpecifier(specifier, fallback) {
  const value = specifier || fallback;
  if (/^(https?:|file:|data:)/.test(value)) {
    return value;
  }
  return new URL(value, import.meta.url).href;
}

async function resolveModuleFactory(moduleFactory, moduleUrl) {
  if (typeof moduleFactory === 'function') {
    return moduleFactory;
  }

  const loaderSpecifier = normalizeSpecifier(moduleUrl, DEFAULT_MODULE_URL);
  const imported = await import(loaderSpecifier);
  const factory = imported.default || imported.createRKDevelopToolModule || imported;

  if (typeof factory !== 'function') {
    throw new Error('Unable to resolve Emscripten module factory function');
  }

  return factory;
}

function setupLogForwarding(FS, onLogWrite) {
  if (typeof onLogWrite !== 'function') {
    return;
  }

  const MEMFS = FS.filesystems?.MEMFS;
  if (
    !MEMFS
    || typeof FS.mount !== 'function'
    || typeof MEMFS.mount !== 'function'
    || typeof MEMFS.createNode !== 'function'
    || typeof MEMFS.stream_ops?.write !== 'function'
  ) {
    return;
  }

  const decoder = new TextDecoder();
  const logFileStreamOps = {
    ...MEMFS.stream_ops,
    write(stream, buffer, offset, length, position, canOwn) {
        let text = '';
        try {
          const chunkBytes = buffer?.subarray
            ? buffer.subarray(offset, offset + length)
            : Uint8Array.from(buffer || []).subarray(offset, offset + length);
          text = decoder.decode(chunkBytes);
        } catch (_error) {
          text = '';
        }

        onLogWrite(text);
		return length;
    },
  };

  const logDirNodeOps = {
    ...MEMFS.node_ops,
    mknod(parent, name, mode, dev) {
      return logVfs.createNode(parent, name, mode, dev);
    },
  };

  const logVfs = {
    ...MEMFS,
    mount(mount) {
      const root = MEMFS.mount(mount);
      root.node_ops = logDirNodeOps;
      return root;
    },
    createNode(parent, name, mode, dev) {
      const node = MEMFS.createNode(parent, name, mode, dev);
      if (FS.isDir(node.mode)) {
        node.node_ops = logDirNodeOps;
      } else if (FS.isFile(node.mode)) {
        node.stream_ops = logFileStreamOps;
      }
      return node;
    },
  };

  const mountPoints = new Set(['/tmp/log']);
  if (typeof FS.cwd === 'function') {
    const currentDir = String(FS.cwd() || '').replace(/\/+$/, '');
    if (currentDir) {
      mountPoints.add(`${currentDir}/log`);
    }
  }

  let mounted = false;
  let firstError = null;
  for (const mountPoint of mountPoints) {
    try {
      ensureDir(FS, mountPoint);
      if (typeof FS.unmount === 'function') {
        try {
          FS.unmount(mountPoint);
        } catch (_error) {
        }
      }
      FS.mount(logVfs, {}, mountPoint);
      mounted = true;
    } catch (error) {
      if (!firstError) {
        firstError = error;
      }
    }
  }

  if (!mounted && firstError) {
    throw firstError;
  }
}

function normalizeArgv(args) {
  if (!Array.isArray(args)) {
    throw new Error('args must be an array');
  }
  return args.map((value) => String(value));
}

export async function createRKDevelopToolWrapper(options = {}) {
  const platform = createPlatformAdapter(options);
  const factory = await resolveModuleFactory(options.moduleFactory, options.moduleUrl);
  const wasmSpecifier = normalizeSpecifier(options.wasmUrl, DEFAULT_WASM_URL);

  let activeRun = null;

  const moduleInstance = await factory({
    noInitialRun: true,
    print: (line) => {
      const text = String(line);
      if (activeRun) {
        activeRun.stdout.push(text);
      }
      if (typeof options.onStdout === 'function') {
        options.onStdout(text);
      }
    },
    printErr: (line) => {
      const text = String(line);
      if (activeRun) {
        activeRun.stderr.push(text);
      }
      if (typeof options.onStderr === 'function') {
        options.onStderr(text);
      }
    },
    locateFile: (fileName) => {
      if (fileName.endsWith('.wasm')) {
        return wasmSpecifier;
      }
      return fileName;
    },
  });

  const FS = moduleInstance.FS;
  ensureDir(FS, '/tmp');
  FS.mount(FS.filesystems.MEMFS, {}, '/tmp');
  FS.writeFile('/tmp/config.ini', '', { encoding: 'utf8' });
  ensureDir(FS, '/tmp/log');
  FS.chdir('/tmp');
  if (typeof options.onLogWrite !== 'function') {
	options.onLogWrite = () => {};
  }
  setupLogForwarding(FS, options.onLogWrite);

  const fs = platform.createFileSystem(moduleInstance, options.fsOptions);

  async function runCommand(args, runOptions = {}) {
    const argv = normalizeArgv(args);

    if (runOptions.requestDevice) {
      await platform.requestDevice(runOptions.usbFilters);
    }

    if (runOptions.fileSource) {
      const fileName = runOptions.fileName || 'input.bin';
      const virtualPath = await fs.mountFile(fileName, runOptions.fileSource);
      if (runOptions.replaceToken) {
        for (let index = 0; index < argv.length; index++) {
          if (argv[index] === runOptions.replaceToken) {
            argv[index] = virtualPath;
          }
        }
      } else {
        argv.push(virtualPath);
      }
    }

    const runState = {
      stdout: [],
      stderr: [],
    };
    activeRun = runState;

    let exitCode = 0;
    try {
      moduleInstance.callMain(argv);
    } catch (error) {
      if (error && typeof error.status === 'number') {
        exitCode = error.status;
      } else {
        activeRun = null;
        throw error;
      }
    }

    activeRun = null;

    return {
      exitCode,
      stdout: runState.stdout.join('\n'),
      stderr: runState.stderr.join('\n'),
    };
  }

  return {
    runtime: platform.runtime,
    module: moduleInstance,
    platform,
    fs,
    requestDevice: (filters) => platform.requestDevice(filters),
    getDevices: () => platform.getDevices(),
    pickFirmwareFile: () => platform.pickFile(),
    mountFile: (name, source) => fs.mountFile(name, source),
    runCommand,
  };
}
