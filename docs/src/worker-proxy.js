/**
 * 主线程代理类，与 Worker 通信来执行 rkdeveloptool 操作
 */
export class RKToolWorkerProxy {
  constructor(workerPath) {
    this.worker = new Worker(workerPath, { type: 'module' });
    this.messageId = 0;
    this.pendingRequests = new Map();
    this.onStdout = null;
    this.onStderr = null;
    this.onLogWrite = null;
    this.initialized = false;

    this.worker.addEventListener('message', (event) => {
      this.handleWorkerMessage(event.data);
    });

    this.worker.addEventListener('error', (error) => {
      console.error('Worker error:', error);
    });
  }

  handleWorkerMessage(message) {
    const { id, type, data } = message;

    // 处理输出消息
    if (type === 'stdout' && this.onStdout) {
      this.onStdout(data.text);
      return;
    }
    if (type === 'stderr' && this.onStderr) {
      this.onStderr(data.text);
      return;
    }
    if (type === 'log' && this.onLogWrite) {
      this.onLogWrite(data.text);
      return;
    }

    // 处理响应消息
    if (id !== null && id !== undefined) {
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        if (type === 'error') {
          const error = new Error(data.message);
          if (data.stack) {
            error.stack = data.stack;
          }
          pending.reject(error);
        } else {
          pending.resolve(data);
        }
      }
    }
  }

  sendRequest(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.messageId;
      this.pendingRequests.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, params });
    });
  }

  async init(options = {}) {
    if (this.initialized) {
      return;
    }

    this.onStdout = options.onStdout || null;
    this.onStderr = options.onStderr || null;
    this.onLogWrite = options.onLogWrite || null;
    this.requestDevice = options.requestDevice || this.requestDeviceFallback;

    const result = await this.sendRequest('init', {
      runtime: options.runtime || 'browser',
      moduleUrl: options.moduleUrl,
      wasmUrl: options.wasmUrl,
    });

    this.initialized = true;
  }

  async requestDeviceFallback() {
    // 在主线程中请求 USB 设备（WebUSB API 只能在主线程使用）
    if (!navigator.usb) {
      throw new Error('WebUSB not supported');
    }

    const device = await navigator.usb.requestDevice({
      filters: [{ vendorId: 0x2207 }],
    });

    return device;
  }

  async getDevices() {
    // 在主线程中获取已授权的设备
    if (!navigator.usb) {
      throw new Error('WebUSB not supported');
    }

    return navigator.usb.getDevices();
  }

  async mountFile(name, file) {
    // 将文件传递给 Worker（File 对象可以通过 postMessage 传递）
    const result = await this.sendRequest('mountFile', { name, file });
    return result.virtualPath;
  }

  async runCommand(args, options = {}) {
    // 如果需要请求设备，在主线程中处理
    if (options.requestDevice) {
      await this.requestDevice();
    }

    // 将命令发送到 Worker 执行
    const result = await this.sendRequest('runCommand', {
      args,
      options: {
        ...options,
        requestDevice: false, // 已经在主线程处理过了
      },
    });

    return result;
  }

  async sleep(duration) {
    await this.sendRequest('sleep', { duration });
  }

  terminate() {
    this.worker.terminate();
    this.pendingRequests.clear();
  }
}

/**
 * 创建 Worker 代理实例
 */
export async function createRKToolWorker(options = {}) {
  const workerPath = options.workerPath || './rktool-worker.js';
  const proxy = new RKToolWorkerProxy(workerPath);

  try {
    await proxy.init(options);
  } catch (error) {
    proxy.terminate();
    options.onStderr?.(`Failed to initialize RKToolWorkerProxy: ${error.message}`);
    throw error;
  }

  return {
    getDevices: () => proxy.getDevices(),
    mountFile: (name, source) => proxy.mountFile(name, source),
    runCommand: (args, options) => proxy.runCommand(args, options),
    sleep: (duration) => proxy.sleep(duration),
    terminate: () => proxy.terminate(),
  };
}
