import { GzipStream } from './gzip-stream.js';
import { XzStream } from './xz-stream.js';

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

function detectDecFormatFromName(fileName) {
  const normalized = String(fileName || '').trim().toLowerCase();
  if (normalized.endsWith('.gz')) {
    return 'gzip';
  }
  if (normalized.endsWith('.xz')) {
    return 'xz';
  }
  return null;
}

function stripDecExtension(fileName) {
  const normalized = String(fileName || 'input.bin.gz').trim() || 'input.bin.gz';
  const stripped = normalized.replace(/\.(gz|xz)$/i, '');
  return stripped || 'input.bin';
}

function resolveDecPreferredName(source, fallbackName) {
  const sourceName = typeof source?.name === 'string' ? source.name.trim() : '';
  const fallback = String(fallbackName || '').trim();

  if (detectDecFormatFromName(sourceName)) {
    return sourceName;
  }

  if (detectDecFormatFromName(fallback)) {
    return fallback;
  }

  return sourceName || fallback || 'input.bin.gz';
}

function resolveDecMount(source, fallbackName, runtime) {
  if (!source || typeof source !== 'object' || typeof source.slice !== 'function') {
    if (isNodeRuntime(runtime)) {
      throw new Error('Node.js runtime gunzip requires a Blob-like source object with slice()');
    }
    throw new Error('Browser runtime gunzip requires a File/Blob-like source object with slice()');
  }

  const compressedName = resolveDecPreferredName(source, fallbackName);
  const decFormat = detectDecFormatFromName(compressedName);
  if (!decFormat) {
    throw new Error('compressed source name must end with .gz or .xz');
  }

  const virtualName = stripDecExtension(compressedName);

  return {
    mountOptions: {
      files: [{
        name: compressedName,
        virtualName,
        data: source,
        mtime: resolveSourceMtime(source),
        decFormat,
      }],
    },
    virtualName,
  };
}

function resolveDecSource(source) {
  const blobSource = source?.data ?? source;
  if (!blobSource || typeof blobSource.slice !== 'function') {
    throw new Error('gunzip source requires a Blob-like object with slice()');
  }

  const sourceName = String(source?.name || '').trim();
  const decFormat = source?.decFormat || detectDecFormatFromName(sourceName);
  let stream = null;

  try {
    if (decFormat === 'gzip') {
      stream = new GzipStream(blobSource);
    } else if (decFormat === 'xz') {
      stream = new XzStream(blobSource);
    } else {
      throw new Error('compressed source name must end with .gz or .xz');
    }

    stream.open();

    return {
      kind: 'blob',
      data: blobSource,
      format: decFormat,
      stream,
      estimatedSize: stream.uncompressedSize,
    };
  } catch (error) {
    if (stream) {
      try {
        stream.close();
      } catch (_closeError) {
      }
    }
    throw error;
  }
}

function closeDecSourceStream(decSource) {
  if (!decSource || !decSource.stream || typeof decSource.stream.close !== 'function') {
    return;
  }

  try {
    decSource.stream.close();
  } catch (_error) {
  }

  decSource.stream = null;
}

function closeDecTree(node) {
  if (!node || typeof node !== 'object') {
    return;
  }

  closeDecSourceStream(node.decSource);

  const entries = node.contents && typeof node.contents === 'object'
    ? Object.values(node.contents)
    : [];
  for (const child of entries) {
    closeDecTree(child);
  }
}

export function ensureRuntimeDirs(FS) {
  ensureDir(FS, '/tmp');
  ensureDir(FS, '/tmp/log');
  ensureDir(FS, DEFAULT_MOUNT_ROOT);
}

async function workerFsForNode(moduleInstance, NodeBlobReaderSync) {

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

function workerFsForDec(moduleInstance) {
  const FS = moduleInstance.FS;
  const WORKERFS = moduleInstance.WORKERFS || FS.filesystems?.WORKERFS;
  if (!WORKERFS) {
    throw new Error('WORKERFS is required for compressed file mapping');
  }

  const DECWORKERFS = {
    ...WORKERFS,
    mount(mount) {
      var root = WORKERFS.createNode(null, '/', WORKERFS.DIR_MODE, 0);

      function base(pathname) {
        var parts = String(pathname || '').split('/').filter((part) => !!part);
        return parts[parts.length - 1] || 'input.bin';
      }

      for (var source of (mount.opts['files'] || [])) {
        var compressedName = String(source.name || 'input.bin.gz');
        var virtualName = String(source.virtualName || stripDecExtension(compressedName));
        var decSource = resolveDecSource({
          ...source,
          name: compressedName,
        });

        try {
          DECWORKERFS.createNode(
            root,
            base(virtualName),
            WORKERFS.FILE_MODE,
            0,
            {
              ...source,
              name: compressedName,
              decSource,
            },
            source.mtime
          );
        } catch (error) {
          closeDecSourceStream(decSource);
          throw error;
        }
      }

      return root;
    },
    unmount(mount) {
      closeDecTree(mount?.root);
      if (typeof WORKERFS.unmount === 'function') {
        return WORKERFS.unmount(mount);
      }
      return null;
    },
    createNode(parent, name, mode, dev, source, mtime) {
      var node = FS.createNode(parent, name, mode);
      node.mode = mode;
      node.node_ops = WORKERFS.node_ops;
      node.stream_ops = DECWORKERFS.stream_ops;
      node.atime = node.mtime = node.ctime = (mtime || new Date()).getTime();
      assert(WORKERFS.FILE_MODE !== WORKERFS.DIR_MODE);

      if (mode === WORKERFS.FILE_MODE) {
        var decSource = source?.decSource;
        if (!decSource) {
          throw new Error('decompression source is missing');
        }
        node.size = decSource.estimatedSize ?? 0;
        node.decSource = decSource;
      } else {
        node.size = 4096;
        node.contents = {};
        node.decSource = null;
      }

      if (parent) {
        parent.contents[name] = node;
      }

      return node;
    },
    stream_ops: {
      ...WORKERFS.stream_ops,
      read(stream, buffer, offset, length, position) {
        const decStream = stream.node?.decSource?.stream;
        if (!decStream) {
          throw new Error('decompression stream is not ready');
        }

        const bytesRead = decStream.read(buffer, offset, length, position);
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

  return DECWORKERFS;
}

function workerFsForRkfw(moduleInstance, NodeBlobReaderSync) {
  const FS = moduleInstance.FS;
  const WORKERFS = moduleInstance.WORKERFS || FS.filesystems?.WORKERFS;
  if (!WORKERFS) {
    throw new Error('WORKERFS is required for compressed file mapping');
  }

  const RKFWWORKERFS = {
    ...WORKERFS,
    reader: null,
    mount(mount) {
      RKFWWORKERFS.reader ??= (NodeBlobReaderSync?new NodeBlobReaderSync():new FileReaderSync());
      var root = WORKERFS.createNode(null, '/', WORKERFS.DIR_MODE, 0);
      var createdParents = {};
      function ensureParent(path) {
        // return the parent node, creating subdirs as necessary
        var parts = path.split('/');
        var parent = root;
        for (var i = 0; i < parts.length-1; i++) {
          var curr = parts.slice(0, i+1).join('/');
          // Issue 4254: Using curr as a node name will prevent the node
          // from being found in FS.nameTable when FS.open is called on
          // a path which holds a child of this node,
          // given that all FS functions assume node names
          // are just their corresponding parts within their given path,
          // rather than incremental aggregates which include their parent's
          // directories.
          createdParents[curr] ||= WORKERFS.createNode(parent, parts[i], WORKERFS.DIR_MODE, 0);
          parent = createdParents[curr];
        }
        return parent;
      }
      function base(pathname) {
        var parts = String(pathname || '').split('/').filter((part) => !!part);
        return parts[parts.length - 1];
      }

      const blob = mount.opts['source'];
      // RkfwInfo
      const meta = mount.opts['meta'];
      if (!blob || typeof blob.slice !== 'function') {
        throw new Error('RKFW mount requires a Blob-like source object with slice()');
      }
      if (!meta || typeof meta !== 'object' || !meta.loader || !Array.isArray(meta.parts)) {
        throw new Error('RKFW mount requires valid metadata with loader and parts information');
      }
      const mounts = [{fileName: 'MiniLoaderAll.bin', offset: meta.loader.offset, size: meta.loader.size}].concat(meta.parts);
      for (var {fileName, offset, size} of mounts) {
        if (fileName === null)
          continue;
        fileName = fileName.replaceAll('\\', '/');
        const range = blob.slice(offset, offset + size);
        RKFWWORKERFS.createFileNode(ensureParent(fileName), base(fileName), range);
      }
      return root;
    },
    createFileNode(parent, name, source) {
      var node = FS.createNode(parent, name, WORKERFS.FILE_MODE);
      node.mode = WORKERFS.FILE_MODE;
      node.node_ops = WORKERFS.node_ops;
      node.stream_ops = RKFWWORKERFS.stream_ops;
      node.size = source.size;
      node.contents = source;

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
        var ab = RKFWWORKERFS.reader.readAsArrayBuffer(chunk);
        buffer.set(new Uint8Array(ab), offset);
        return chunk.size;
      },
    },
  };

  return RKFWWORKERFS;
}

export async function createFsWrapper(moduleInstance, options = {}) {
  if (!moduleInstance || !moduleInstance.FS) {
    throw new Error('moduleInstance.FS is required');
  }

  const runtime = options.runtime || 'node';
  const mountRoot = options.mountRoot || DEFAULT_MOUNT_ROOT;
  const FS = moduleInstance.FS;
  const WORKERFS = moduleInstance.WORKERFS || FS.filesystems?.WORKERFS;
  if (!WORKERFS) {
    throw new Error('WORKERFS is required for file mapping');
  }
  const NodeBlobReaderSync = isNodeRuntime(runtime) ? (await import('./node-blob.js')).NodeBlobReaderSync : null;
  const NODEWORKERFS = isNodeRuntime(runtime) ? await workerFsForNode(moduleInstance, NodeBlobReaderSync) : null;
  const DECWORKERFS = workerFsForDec(moduleInstance);
  const RKFWWORKERFS = workerFsForRkfw(moduleInstance, NodeBlobReaderSync);


  ensureRuntimeDirs(FS);
  ensureDir(FS, mountRoot);

  function createMountResult(mountPoint, virtualName) {
    return {
      virtualPath: `${mountPoint}/${virtualName}`,
      mountPoint,
    };
  }

  async function mountFile(name, source, gunzip = false, rkfw = false) {
    if (!source) {
      throw new Error('source is required');
    }
    if (gunzip && rkfw) {
      throw new Error('gunzip and rkfw options cannot be used together');
    }
    const mountName = toMountName(name);
    const mountPoint = `${mountRoot}/${mountName}`;
    ensureDir(FS, mountPoint);
  
    if (rkfw) {
      FS.mount(RKFWWORKERFS, source, mountPoint);
      return createMountResult(mountPoint, null);
    }

    if (gunzip) {
      const decMount = resolveDecMount(source, name, runtime);
      FS.mount(DECWORKERFS, decMount.mountOptions, mountPoint);
      return createMountResult(mountPoint, decMount.virtualName);
    }

    const mount = resolveBrowserMount(source, name);
    if (isBrowserRuntime(runtime)) {
      
      try {
        FS.mount(WORKERFS, mount.mountOptions, mountPoint);
      } catch (error) {
        const errorMessage = String(error && error.message ? error.message : error);
        throw new Error(`Failed to mount source with WORKERFS: ${errorMessage}`);
      }

      return createMountResult(mountPoint, mount.virtualName);
    }

    if (isNodeRuntime(runtime)) {
      FS.mount(NODEWORKERFS, mount.mountOptions, mountPoint);
      return createMountResult(mountPoint, mount.virtualName);
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
