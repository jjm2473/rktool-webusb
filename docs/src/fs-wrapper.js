import { GzipStream } from './gzip-stream.js';

function assert(condition, text) {
  if (!condition) {
    throw new Error(text || 'Assertion failed');
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

function preferredSourceName(source, fallbackName, defaultName = 'input.bin') {
  if (typeof source?.name === 'string' && source.name.trim()) {
    return source.name;
  }

  const fallback = String(fallbackName || defaultName).trim();
  return fallback || defaultName;
}

function resolveSourceMtime(source) {
  const numericLastModified = Number(source?.lastModified);
  if (Number.isFinite(numericLastModified)) {
    return new Date(Math.trunc(numericLastModified));
  }

  if (source?.lastModifiedDate instanceof Date) {
    return source.lastModifiedDate;
  }

  return undefined;
}

function resolveBrowserMount(source, fallbackName) {
  if (!source || typeof source !== 'object') {
    throw new Error('Browser runtime requires a File/Blob-like source object');
  }

  const preferredName = preferredSourceName(source, fallbackName, 'input.bin');

  return {
    mountOptions: {
      files: [source],
    },
    virtualName: preferredName,
  };
}

function stripGzipExtension(fileName) {
  const normalized = String(fileName || 'input.bin.gz').trim() || 'input.bin.gz';
  const stripped = normalized.replace(/\.gz$/i, '');
  return stripped || 'input.bin';
}

function resolveGunzipMount(source, fallbackName, runtime) {
  if (!source || typeof source !== 'object' || typeof source.slice !== 'function') {
    if (isNodeRuntime(runtime)) {
      throw new Error('Node.js runtime gunzip requires a Blob-like source object with slice()');
    }
    throw new Error('Browser runtime gunzip requires a File/Blob-like source object with slice()');
  }

  const preferredName = preferredSourceName(source, fallbackName, 'input.bin.gz');
  const virtualName = stripGzipExtension(preferredName);

  return {
    mountOptions: {
      files: [{
        name: virtualName,
        data: source,
        mtime: resolveSourceMtime(source),
      }],
    },
    virtualName,
  };
}

function resolveGunzipSource(source) {
  const blobSource = source?.data ?? source;
  if (!blobSource || typeof blobSource.slice !== 'function') {
    throw new Error('gunzip source requires a Blob-like object with slice()');
  }

  const sizeProbe = new GzipStream(blobSource);

  return {
    kind: 'blob',
    data: blobSource,
    estimatedSize: sizeProbe.uncompressedSize,
  };
}

export function ensureRuntimeDirs(FS) {
  ensureDir(FS, '/tmp');
  ensureDir(FS, '/tmp/log');
  ensureDir(FS, DEFAULT_MOUNT_ROOT);
}

async function workerFsForNode(moduleInstance) {

  const NodeBlobReaderSync = (await import('./node-blob.js')).NodeBlobReaderSync;

  const FS = moduleInstance.FS;
  const WORKERFS = moduleInstance.WORKERFS || FS.filesystems?.WORKERFS;
  if (!WORKERFS) {
    throw new Error('WORKERFS is required for file mapping');
  }

  const NODEWORKERFS = {
    ...WORKERFS,
    reader: null,
    mount(mount) {
      NODEWORKERFS.reader ??= new NodeBlobReaderSync();
      var root = WORKERFS.createNode(null, '/', WORKERFS.DIR_MODE, 0);
      for (var file of (mount.opts["files"] || [])) {
        NODEWORKERFS.createNode(root, file.name, WORKERFS.FILE_MODE, 0, file, file.lastModifiedDate);
      }
      return root;
    },
    createNode(parent, name, mode, dev, source, mtime) {
      var node = FS.createNode(parent, name, mode);
      node.mode = mode;
      node.node_ops = WORKERFS.node_ops;
      node.stream_ops = NODEWORKERFS.stream_ops;
      const rawTimestamp = mtime || source?.mtime || Date.now();
      const normalizedTimestamp = rawTimestamp instanceof Date
        ? rawTimestamp.getTime()
        : Number(rawTimestamp);
      const safeTimestamp = Number.isFinite(normalizedTimestamp)
        ? normalizedTimestamp
        : Date.now();
      node.atime = node.mtime = node.ctime = safeTimestamp;
      assert(WORKERFS.FILE_MODE !== WORKERFS.DIR_MODE);

      if (mode === WORKERFS.FILE_MODE) {
        node.size = Math.max(0, Math.trunc(Number(source.size)));
        node.contents = source;
      } else {
        node.size = 4096;
        node.contents = null;
      }

      if (parent) {
        parent.contents[name] = node;
      }

      return node;
    },
    stream_ops: {
      ...WORKERFS.stream_ops,
      read(stream, buffer, offset, length, position) {
        if (position >= stream.node.size) return 0;
        var chunk = stream.node.contents.slice(position, position + length);
        var ab = NODEWORKERFS.reader.readAsArrayBuffer(chunk);
        buffer.set(new Uint8Array(ab), offset);
        return chunk.size;
      },
    },
  };
  return NODEWORKERFS;
}

function workerFsForGunzip(moduleInstance) {
  const FS = moduleInstance.FS;
  const WORKERFS = moduleInstance.WORKERFS || FS.filesystems?.WORKERFS;
  if (!WORKERFS) {
    throw new Error('WORKERFS is required for gzip file mapping');
  }

  const GZIPWORKERFS = {
    ...WORKERFS,
    mount(mount) {
      var root = WORKERFS.createNode(null, '/', WORKERFS.DIR_MODE, 0);

      function base(pathname) {
        var parts = String(pathname || '').split('/').filter((part) => !!part);
        return parts[parts.length - 1] || 'input.bin';
      }

      for (var source of (mount.opts['files'] || [])) {
        var virtualName = String(source.name || 'input.bin');
        GZIPWORKERFS.createNode(
          root,
          base(virtualName),
          WORKERFS.FILE_MODE,
          0,
          source,
          source.mtime
        );
      }

      return root;
    },
    createNode(parent, name, mode, dev, source, mtime) {
      var node = FS.createNode(parent, name, mode);
      node.mode = mode;
      node.node_ops = WORKERFS.node_ops;
      node.stream_ops = GZIPWORKERFS.stream_ops;
      node.atime = node.mtime = node.ctime = (mtime || new Date()).getTime();
      assert(WORKERFS.FILE_MODE !== WORKERFS.DIR_MODE);

      if (mode === WORKERFS.FILE_MODE) {
        var gzipSource = resolveGunzipSource(source);
        node.size = gzipSource.estimatedSize ?? 0;
        node.gzSource = gzipSource;
      } else {
        node.size = 4096;
        node.contents = {};
        node.gzSource = null;
      }

      if (parent) {
        parent.contents[name] = node;
      }

      return node;
    },
    stream_ops: {
      ...WORKERFS.stream_ops,
      open(stream) {
        var gzipSource = stream.node.gzSource;
        if (!gzipSource) {
          throw new Error('gzip source is missing');
        }

        stream.gzStream = new GzipStream(gzipSource.data);
        stream.gzStream.open();
      },
      close(stream) {
        if (stream.gzStream) {
          stream.gzStream.close();
          stream.gzStream = null;
        }
      },
      read(stream, buffer, offset, length, position) {
        if (!stream.gzStream) {
          throw new Error('gzip stream is not open');
        }

        const bytesRead = stream.gzStream.read(buffer, offset, length, position);
        if (bytesRead > 0 && typeof position === 'number') {
          const endPosition = position + bytesRead;
          if (endPosition > stream.node.size) {
            stream.node.size = endPosition;
          }
        }

        return bytesRead;
      },
    },
  };

  return GZIPWORKERFS;
}

export async function createFsWrapper(moduleInstance, options = {}) {
  if (!moduleInstance || !moduleInstance.FS) {
    throw new Error('moduleInstance.FS is required');
  }

  const runtime = options.runtime || 'node';
  const mountRoot = options.mountRoot || DEFAULT_MOUNT_ROOT;
  const FS = moduleInstance.FS;
  const WORKERFS = moduleInstance.WORKERFS || FS.filesystems?.WORKERFS;
  const NODEFS = moduleInstance.NODEFS || FS.filesystems?.NODEFS;
  const NODEWORKERFS = isNodeRuntime(runtime) ? await workerFsForNode(moduleInstance) : null;

  ensureRuntimeDirs(FS);
  ensureDir(FS, mountRoot);

  async function mountFile(name, source, gunzip = false) {
    if (!source) {
      throw new Error('source is required');
    }
    if (!WORKERFS) {
      throw new Error('WORKERFS is required for file mapping');
    }
    const mountName = toMountName(name);
    const mountPoint = `${mountRoot}/${mountName}`;
    ensureDir(FS, mountPoint);

    if (gunzip) {
      const gunzipMount = resolveGunzipMount(source, name, runtime);
      const GZIPWORKERFS = workerFsForGunzip(moduleInstance);
      FS.mount(GZIPWORKERFS, gunzipMount.mountOptions, mountPoint);
      return `${mountPoint}/${gunzipMount.virtualName}`;
    }

    const mount = resolveBrowserMount(source, name);
    if (isBrowserRuntime(runtime)) {
      
      try {
        FS.mount(WORKERFS, mount.mountOptions, mountPoint);
      } catch (error) {
        const errorMessage = String(error && error.message ? error.message : error);
        throw new Error(`Failed to mount source with WORKERFS: ${errorMessage}`);
      }

      return `${mountPoint}/${mount.virtualName}`;
    }

    if (isNodeRuntime(runtime)) {
      FS.mount(NODEWORKERFS, mount.mountOptions, mountPoint);
      return `${mountPoint}/${mount.virtualName}`;
    }

    throw new Error(`Unsupported runtime: ${runtime}`);
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
    unmount,
  };
}
