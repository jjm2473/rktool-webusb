import { createPlatformAdapter } from './platform-adapter.js';

const DEFAULT_MODULE_URL = '../dist/rkdeveloptool.js';
const DEFAULT_WASM_URL = '../dist/rkdeveloptool.wasm';

function ensureDir(FS, dirPath) {
  try {
    FS.mkdir(dirPath);
  } catch (error) {
    if (!String(error && error.message).includes('File exists')) {
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

  const memfs = FS.filesystems && FS.filesystems.MEMFS;
  if (!memfs || !memfs.stream_ops || memfs.stream_ops.__rkLogForwardPatched) {
    return;
  }

  const decoder = new TextDecoder();
  const originalWrite = memfs.stream_ops.write;

  memfs.stream_ops.write = function patchedWrite(stream, buffer, offset, length, position, canOwn) {
    const written = originalWrite.call(this, stream, buffer, offset, length, position, canOwn);

    if (written > 0 && stream && stream.path && stream.path.startsWith('/tmp/log/')) {
      const chunkBytes = buffer.subarray(offset, offset + written);
      onLogWrite({
        path: stream.path,
        text: decoder.decode(chunkBytes),
        bytes: written,
      });
    }

    return written;
  };

  memfs.stream_ops.__rkLogForwardPatched = true;
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
  ensureDir(FS, '/tmp/log');
  FS.chdir('/tmp');
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
