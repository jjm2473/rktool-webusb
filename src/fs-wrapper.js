var ENVIRONMENT_IS_NODE = globalThis.process?.versions?.node && globalThis.process?.type != "renderer";

if (ENVIRONMENT_IS_NODE) {
  // When building an ES module `require` is not normally available.
  // We need to use `createRequire()` to construct the require()` function.
  const {createRequire} = await import("node:module");
  /** @suppress{duplicate} */ var require = createRequire(import.meta.url);

  var fs = require("node:fs");
  var assert = function (condition, text) {
    if (!condition) {
      // This build was created without ASSERTIONS defined.  `assert()` should not
      // ever be called in this configuration but in case there are callers in
      // the wild leave this simple abort() implementation here for now.
      abort(text);
    }
  }
}

const DEFAULT_MOUNT_ROOT = '/tmp/mounts';

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

function sanitizeSegment(name) {
  return String(name || 'input')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'input';
}

function toMountName(name) {
  return `${sanitizeSegment(name)}-${Date.now()}`;
}

function isNodeRuntime(runtime) {
  return runtime === 'node';
}

function isBrowserRuntime(runtime) {
  return runtime === 'browser';
}

function resolveBrowserMount(source, fallbackName) {
  if (!source || typeof source !== 'object') {
    throw new Error('Browser runtime requires a File/Blob-like source object');
  }

  const preferredName = typeof source.name === 'string' && source.name.trim()
    ? source.name
    : String(fallbackName || 'input.bin');

  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    return {
      mountOptions: {
        blobs: [{
          name: preferredName,
          data: source,
        }],
      },
      virtualName: preferredName,
    };
  }

  return {
    mountOptions: {
      files: [source],
    },
    virtualName: preferredName,
  };
}

export function ensureRuntimeDirs(FS) {
  ensureDir(FS, '/tmp');
  ensureDir(FS, '/tmp/log');
  ensureDir(FS, DEFAULT_MOUNT_ROOT);
}

export function workerFsForNode(moduleInstance) {
  const FS = moduleInstance.FS;
  const WORKERFS = moduleInstance.WORKERFS || FS.filesystems?.WORKERFS;
  if (!WORKERFS) {
    throw new Error('WORKERFS is required for browser file mapping');
  }

  const NODEWORKERFS = {
    ...WORKERFS,
    mount(mount) {
      //assert(ENVIRONMENT_IS_WORKER);
      //WORKERFS.reader ??= new FileReaderSync;
      var root = WORKERFS.createNode(null, "/", WORKERFS.DIR_MODE, 0);
      // We also accept FileList here
      for (var source of (mount.opts["files"] || [])) {
        NODEWORKERFS.createNode(root, source.name, WORKERFS.FILE_MODE, 0, source.path);
      }
      return root;
    },
    createNode(parent, name, mode, dev, path) {
      var stat = fs.lstatSync(path);
      var size = stat.size;
      var mtime = stat.mtime;
      var node = FS.createNode(parent, name, mode);
      node.mode = mode;
      node.node_ops = WORKERFS.node_ops;
      node.stream_ops = NODEWORKERFS.stream_ops;
      node.atime = node.mtime = node.ctime = mtime;
      assert(WORKERFS.FILE_MODE !== WORKERFS.DIR_MODE);
      if (mode === WORKERFS.FILE_MODE) {
        node.size = size;
        node.hostpath = path;
      } else {
        // should now go here
        node.size = 4096;
        node.hostpath = null;
      }
      if (parent) {
        parent.contents[name] = node;
      }
      return node;
    },
    stream_ops: {
      ...WORKERFS.stream_ops,
      open(stream) {
        var path = stream.node.hostpath;
        stream.nfd = fs.openSync(path, stream.flags);
      },
      close(stream) {
        fs.closeSync(stream.nfd);
      },
      read(stream, buffer, offset, length, position) {
        return fs.readSync(stream.nfd, buffer, offset, length, position);
      },
      write(stream, buffer, offset, length, position) {
        return fs.writeSync(stream.nfd, buffer, offset, length, position);
      },
    },
  };
  return NODEWORKERFS;
}

export function createFsWrapper(moduleInstance, options = {}) {
  if (!moduleInstance || !moduleInstance.FS) {
    throw new Error('moduleInstance.FS is required');
  }

  const runtime = options.runtime || 'node';
  const mountRoot = options.mountRoot || DEFAULT_MOUNT_ROOT;
  const FS = moduleInstance.FS;
  const WORKERFS = moduleInstance.WORKERFS || FS.filesystems?.WORKERFS;
  const NODEFS = moduleInstance.NODEFS || FS.filesystems?.NODEFS;

  ensureRuntimeDirs(FS);
  ensureDir(FS, mountRoot);

  async function mountFile(name, source) {
    if (!source) {
      throw new Error('source is required');
    }
    if (!WORKERFS) {
      throw new Error('WORKERFS is required for file mapping');
    }
    const mountName = toMountName(name);
    const mountPoint = `${mountRoot}/${mountName}`;
    ensureDir(FS, mountPoint);

    if (isBrowserRuntime(runtime)) {
      const browserMount = resolveBrowserMount(source, name);
      try {
        FS.mount(WORKERFS, browserMount.mountOptions, mountPoint);
      } catch (error) {
        const errorMessage = String(error && error.message ? error.message : error);
        throw new Error(`Failed to mount source with WORKERFS: ${errorMessage}`);
      }

      return `${mountPoint}/${browserMount.virtualName}`;
    }

    if (isNodeRuntime(runtime)) {
      const NODEWORKERFS = workerFsForNode(moduleInstance);

      if (typeof source !== 'string') {
        throw new Error('Node.js runtime requires source to be a local file path string');
      }

      const pathModule = await import('node:path');
      const absolutePath = pathModule.resolve(String(source));
      const baseName = pathModule.basename(absolutePath);
      FS.mount(NODEWORKERFS, { files: [{path: source, name: baseName}] }, mountPoint);
      return `${mountPoint}/${baseName}`;
    }

    throw new Error(`Unsupported runtime: ${runtime}`);
  }

  async function mountDirectory(name, source) {
    if (!isNodeRuntime(runtime)) {
      throw new Error('mountDirectory is only supported in Node.js runtime');
    }

    if (!NODEFS) {
      return String(source);
    }

    const pathModule = await import('node:path');
    const absolutePath = pathModule.resolve(String(source));
    const mountPoint = `${mountRoot}/${toMountName(name || 'dir')}`;
    ensureDir(FS, mountPoint);
    FS.mount(NODEFS, { root: absolutePath }, mountPoint);
    return mountPoint;
  }

  function unmount(mountPoint) {
    try {
      FS.unmount(mountPoint);
    } catch (error) {
      if (!String(error && error.message).includes('not mounted')) {
        throw error;
      }
    }
  }

  return {
    mountFile,
    mountDirectory,
    unmount,
  };
}
