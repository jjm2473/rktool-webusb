import { createRKDevelopToolWrapper } from './rkdeveloptool-wrapper.js';

let wrapper = null;
let pakoInflateReadyPromise = null;

async function ensurePakoInflate() {
  if (typeof globalThis.pako?.Inflate === 'function') {
    return;
  }

  if (!pakoInflateReadyPromise) {
    pakoInflateReadyPromise = (async () => {
      const moduleSpecifiers = [
        'https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.esm.mjs',
        'https://esm.sh/pako@2.1.0',
      ];
      let pakoModule = null;
      let lastError = null;

      for (const moduleSpecifier of moduleSpecifiers) {
        try {
          pakoModule = await import(moduleSpecifier);
          break;
        } catch (error) {
          lastError = error;
        }
      }

      if (!pakoModule) {
        throw new Error(`Failed to load pako module: ${String(lastError && lastError.message ? lastError.message : lastError)}`);
      }

      const inflateCtor = pakoModule.Inflate || pakoModule.default?.Inflate;
      if (typeof inflateCtor !== 'function') {
        throw new Error('Loaded pako module does not export Inflate constructor');
      }

      const previousPako = globalThis.pako && typeof globalThis.pako === 'object'
        ? globalThis.pako
        : {};

      globalThis.pako = {
        ...previousPako,
        Inflate: inflateCtor,
      };
    })();
  }

  await pakoInflateReadyPromise;
}

// 发送消息回主线程
function postResponse(id, type, data) {
  self.postMessage({ id, type, data });
}

function postError(id, error) {
  self.postMessage({
    id,
    type: 'error',
    data: {
      message: error.message || String(error),
      stack: error.stack,
    },
  });
}

// 发送输出消息
function postOutput(type, text) {
  self.postMessage({
    id: null,
    type,
    data: { text },
  });
}

// 处理来自主线程的消息
self.addEventListener('message', async (event) => {
  const { id, method, params } = event.data;

  try {
    switch (method) {
      case 'init': {
        const { runtime, moduleUrl, wasmUrl } = params || {};
        await ensurePakoInflate();
        wrapper = await createRKDevelopToolWrapper({
          runtime: runtime || 'browser',
          moduleUrl,
          wasmUrl,
          onStdout: (text) => postOutput('stdout', text),
          onStderr: (text) => postOutput('stderr', text),
          onLogWrite: (text) => postOutput('log', text),
        });
        postResponse(id, 'init-complete', { runtime: wrapper.runtime });
        break;
      }

      case 'mountFile': {
        if (!wrapper) {
          throw new Error('Wrapper not initialized');
        }
        const { name, file } = params;
        const mountResult = await wrapper.mountFile(name, file);
        postResponse(id, 'mountFile-complete', mountResult);
        break;
      }

      case 'umount': {
        if (!wrapper) {
          throw new Error('Wrapper not initialized');
        }
        const mountPoint = params;
        const umountResult = wrapper.umount(mountPoint);
        postResponse(id, 'umount-complete', umountResult);
        break;
      }

      case 'runCommand': {
        if (!wrapper) {
          throw new Error('Wrapper not initialized');
        }
        const { args, options } = params;
        const result = await wrapper.runCommand(args, options);
        postResponse(id, 'runCommand-complete', result);
        break;
      }

      case 'sleep': {
        const { duration } = params;
        await new Promise((resolve) => setTimeout(resolve, duration));
        postResponse(id, 'sleep-complete', {});
        break;
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  } catch (error) {
    postError(id, error);
  }
});

// 通知主线程 Worker 已准备好
self.postMessage({ type: 'ready' });
