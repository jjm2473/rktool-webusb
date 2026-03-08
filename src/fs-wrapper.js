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

export function ensureRuntimeDirs(FS) {
  ensureDir(FS, '/tmp');
  ensureDir(FS, '/tmp/log');
  ensureDir(FS, DEFAULT_MOUNT_ROOT);
}

export function createFsWrapper(moduleInstance, options = {}) {
  if (!moduleInstance || !moduleInstance.FS) {
    throw new Error('moduleInstance.FS is required');
  }

  const runtime = options.runtime || 'node';
  const mountRoot = options.mountRoot || DEFAULT_MOUNT_ROOT;
  const FS = moduleInstance.FS;
  const WORKERFS = moduleInstance.WORKERFS;
  const NODEFS = moduleInstance.NODEFS;

  ensureRuntimeDirs(FS);
  ensureDir(FS, mountRoot);

  async function mountFile(name, source) {
    if (!source) {
      throw new Error('source is required');
    }

    const mountName = toMountName(name);
    const mountPoint = `${mountRoot}/${mountName}`;
    ensureDir(FS, mountPoint);

    if (isBrowserRuntime(runtime)) {
      if (!WORKERFS) {
        throw new Error('WORKERFS is not available in current module');
      }

      const fileObject = source;
      const fileName = fileObject.name || name || 'input.bin';
      FS.mount(WORKERFS, { files: [fileObject] }, mountPoint);
      return `${mountPoint}/${fileName}`;
    }

    if (isNodeRuntime(runtime)) {
      const pathModule = await import('node:path');
      const absolutePath = pathModule.resolve(String(source));
      const parentDir = pathModule.dirname(absolutePath);
      const baseName = pathModule.basename(absolutePath);

      if (!NODEFS) {
        return absolutePath;
      }

      FS.mount(NODEFS, { root: parentDir }, mountPoint);
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
