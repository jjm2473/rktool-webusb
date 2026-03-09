import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRKDevelopToolWrapper } from '../../src/rkdeveloptool-wrapper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const distJsPath = path.join(projectRoot, 'dist', 'rkdeveloptool.js');
const distWasmPath = path.join(projectRoot, 'dist', 'rkdeveloptool.wasm');
const DEFAULT_MOCK_USB_DEVICE = {
  deviceDescriptor: {
    idVendor: 0x2207,
    idProduct: 0x350b,
  },
};

function createMockNodeUsb(devices = [DEFAULT_MOCK_USB_DEVICE]) {
  return {
    getDeviceList() {
      return devices;
    },
  };
}

function createMockUsb(options = {}) {
  const devices = options.devices || [{ vendorId: 0x2207, productId: 0x350b }];
  const state = {
    requestDeviceCallCount: 0,
    getDevicesCallCount: 0,
    lastRequestOptions: null,
  };

  return {
    state,
    webUsb: {
      async requestDevice(requestOptions) {
        state.requestDeviceCallCount++;
        state.lastRequestOptions = requestOptions;
        if (options.requestDeviceError) {
          throw options.requestDeviceError;
        }
        if (Object.prototype.hasOwnProperty.call(options, 'requestDeviceResult')) {
          return options.requestDeviceResult;
        }
        return devices[0] || null;
      },
      async getDevices() {
        state.getDevicesCallCount++;
        return devices;
      },
    },
    nodeUsb: {
      getDeviceList() {
        return devices;
      },
    }
  };
}

function toDataView(bytes) {
  const payload = Uint8Array.from(bytes);
  return new DataView(payload.buffer);
}

function byteLengthOf(data) {
  if (!data) {
    return 0;
  }

  if (typeof data.byteLength === 'number') {
    return data.byteLength;
  }

  if (typeof data.length === 'number') {
    return data.length;
  }

  return 0;
}

function createZeroDataView(length) {
  const parsedLength = Number(length);
  const safeLength = Number.isFinite(parsedLength)
    ? Math.max(0, Math.min(Math.trunc(parsedLength), 1024 * 1024))
    : 0;
  const payload = new Uint8Array(safeLength);
  return new DataView(payload.buffer);
}

function createRockusbWebUsbDevice(options = {}) {
  const vid = options.vid ?? 0x2207;
  const pid = options.pid ?? 0x320a;
  const bcdUsb = options.bcdUsb ?? 0x0200;
//   const sessionIdSymbol = Symbol.for('libusb.session_id');
//   const sessionId = options.sessionId ?? Math.floor(Math.random() * 0x7fffffff);

  const transportState = {
    openCallCount: 0,
    closeCallCount: 0,
    controlTransferInCalls: [],
    transferInCalls: [],
    transferOutCalls: [],
  };

  const deviceDescriptor = [
    18,
    1,
    bcdUsb & 0xff,
    (bcdUsb >> 8) & 0xff,
    0,
    0,
    0,
    64,
    vid & 0xff,
    (vid >> 8) & 0xff,
    pid & 0xff,
    (pid >> 8) & 0xff,
    0,
    0,
    1,
    2,
    3,
    1,
  ];

  const configDescriptor = [
    9, 2, 32, 0, 1, 1, 0, 0x80, 50,
    9, 4, 0, 0, 2, 0xff, 6, 5, 0,
    7, 5, 0x81, 2, 0x00, 0x02, 0,
    7, 5, 0x01, 2, 0x00, 0x02, 0,
  ];

  const device = {
    vendorId: vid,
    productId: pid,
    opened: false,
    configuration: { configurationValue: 1 },
    async open() {
      console.debug(`Device open called (vid: ${vid.toString(16)}, pid: ${pid.toString(16)})`);
      transportState.openCallCount++;
      this.opened = true;
      return 0;
    },
    async close() {
      transportState.closeCallCount++;
      this.opened = false;
    },
    async controlTransferIn(params, length) {
      transportState.controlTransferInCalls.push({ params, length });
      console.debug(`Device controlTransferIn called (vid: ${vid.toString(16)}, pid: ${pid.toString(16)}, params: ${JSON.stringify(params)}, length: ${length})`);
      const descriptorType = (params.value >> 8) & 0xff;
      if (descriptorType === 1) {
        return { status: 'ok', data: toDataView(deviceDescriptor) };
      }
      if (descriptorType === 2) {
        return { status: 'ok', data: toDataView(configDescriptor) };
      }
      return { status: 'stall', data: toDataView([]) };
    },
    async controlTransferOut(_params, data) {
      return { status: 'ok', bytesWritten: byteLengthOf(data) };
    },
    async transferIn(endpointNumber, length) {
      transportState.transferInCalls.push({ endpointNumber, length });
      return { status: 'ok', data: createZeroDataView(length) };
    },
    async transferOut(endpointNumber, data) {
      transportState.transferOutCalls.push({ endpointNumber, length: byteLengthOf(data) });
      return { status: 'ok', bytesWritten: byteLengthOf(data) };
    },
    async bulkTransferIn(endpointNumber, length) {
      return this.transferIn(endpointNumber, length);
    },
    async bulkTransferOut(endpointNumber, data) {
      return this.transferOut(endpointNumber, data);
    },
    async claimInterface() { return 0;},
    async releaseInterface() {},
    async selectAlternateInterface() {},
    async clearHalt() {},
    async reset() {},
    async setConfiguration(value) {
      this.configuration = { configurationValue: value };
    },
  };

  // device[sessionIdSymbol] = sessionId;

  return { device, transportState };
}

function createUnitTestWrapperOptions(overrides = {}) {
  return {
    runtime: 'node',
    nodeUsb: createMockNodeUsb(),
    loadNodeUsb: async () => {
      throw new Error('loadNodeUsb should not be called in unit tests');
    },
    ...overrides,
  };
}

function hasBuiltWasmArtifacts() {
  return fs.existsSync(distJsPath) && fs.existsSync(distWasmPath);
}

function hasWorkerFsSupport() {
  return typeof FileReaderSync === 'function';
}

function createBrowserFileFromPath(filePath, fileName = path.basename(filePath)) {
  const bytes = fs.readFileSync(filePath);
  if (typeof File === 'function') {
    return new File([bytes], fileName, { type: 'application/octet-stream' });
  }

  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  Object.defineProperty(blob, 'name', {
    value: fileName,
    configurable: true,
  });
  return blob;
}

async function withMockNavigatorUsb(webUsb, callback) {
  const navigatorObject = globalThis.navigator;
  const previousUsb = navigatorObject?.usb;
  const hadUsb = Object.prototype.hasOwnProperty.call(navigatorObject || {}, 'usb');

  if (!navigatorObject) {
    throw new Error('global navigator object is required for WebUSB tests');
  }

  globalThis.navigator.usb = webUsb;
  try {
    return await callback();
  } finally {
    if (hadUsb) {
      globalThis.navigator.usb = previousUsb;
    } else {
      delete globalThis.navigator.usb;
    }
  }
}

let realFlowQueue = Promise.resolve();

async function runRealFlowInOrder(callback) {
  const previous = realFlowQueue;
  let releaseQueue = () => {};
  realFlowQueue = new Promise((resolve) => {
    releaseQueue = resolve;
  });

  await previous;
  try {
    return await callback();
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseQueue();
  }
}

function parseRkdeveloptoolCommand(commandLine) {
  const parts = String(commandLine).trim().split(/\s+/);
  if (parts[0] !== 'rkdeveloptool') {
    throw new Error('command must start with rkdeveloptool');
  }
  return parts.slice(1);
}

function createMockEmscriptenModule() {
  const dirs = new Set(['/']);
  const mounts = new Map();
  const files = new Map();
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
      writeFile(pathname, content) {
        files.set(pathname, content);
      },
    },
    NODEFS: { kind: 'NODEFS' },
    WORKERFS: { kind: 'WORKERFS' },
    streamOps,
    files,
  };
}

test('runCommand waits for async callMain completion', async () => {
  let capturedArgv = [];
  let callMainCompleted = false;

  const wrapper = await createRKDevelopToolWrapper(createUnitTestWrapperOptions({
    moduleFactory: async (moduleOptions) => {
      const mockModule = createMockEmscriptenModule();
      mockModule.callMain = async (argv) => {
        capturedArgv = argv;
        await new Promise((resolve) => setTimeout(resolve, 10));
        callMainCompleted = true;
        moduleOptions.print('async-stdout-line');
      };
      return mockModule;
    },
  }));

  const result = await wrapper.runCommand(['ld']);

  assert.equal(callMainCompleted, true);
  assert.deepEqual(capturedArgv, ['ld']);
  assert.equal(result.exitCode, 0);
});

test('runCommand replaces token with mounted path', async () => {
  let capturedArgv = [];

  const wrapper = await createRKDevelopToolWrapper(createUnitTestWrapperOptions({
    moduleFactory: async () => {
      const mockModule = createMockEmscriptenModule();
      mockModule.callMain = (argv) => {
        capturedArgv = argv;
      };
      return mockModule;
    },
  }));

  await wrapper.runCommand(['db', '$FILE'], {
    fileSource: '/tmp/loader.bin',
    replaceToken: '$FILE',
    fileName: 'loader.bin',
  });

  assert.equal(capturedArgv[0], 'db');
  assert.match(capturedArgv[1], /^\/tmp\/mounts\/.+\/loader\.bin$/);
});

test('simulate command: rkdeveloptool ld', async () => {
  let capturedArgv = [];

  const wrapper = await createRKDevelopToolWrapper(createUnitTestWrapperOptions({
    moduleFactory: async (moduleOptions) => {
      const mockModule = createMockEmscriptenModule();
      mockModule.callMain = (argv) => {
        capturedArgv = argv;
        moduleOptions.print('List Device OK');
      };
      return mockModule;
    },
  }));

  const args = parseRkdeveloptoolCommand('rkdeveloptool ld');
  const result = await wrapper.runCommand(args);

  assert.deepEqual(capturedArgv, ['ld']);
  assert.equal(result.exitCode, 0);
});

test('simulate command: rkdeveloptool db loader/MiniLoaderAll.bin', async () => {
  let capturedArgv = [];
  const fixturePath = path.join(projectRoot, 'tests', 'loader', 'MiniLoaderAll.bin');
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rktool-db-'));
  const sandboxLoaderDir = path.join(sandboxDir, 'loader');
  const sandboxLoaderPath = path.join(sandboxLoaderDir, 'MiniLoaderAll.bin');

  fs.mkdirSync(sandboxLoaderDir, { recursive: true });
  fs.copyFileSync(fixturePath, sandboxLoaderPath);

  const wrapper = await createRKDevelopToolWrapper(createUnitTestWrapperOptions({
    moduleFactory: async (moduleOptions) => {
      const mockModule = createMockEmscriptenModule();
      mockModule.callMain = (argv) => {
        capturedArgv = argv;
        const loaderAbsolutePath = path.join(sandboxDir, argv[1]);
        if (!fs.existsSync(loaderAbsolutePath)) {
          throw new Error(`loader not found: ${loaderAbsolutePath}`);
        }
        moduleOptions.print(`Download Boot OK: ${argv[1]}`);
      };
      return mockModule;
    },
  }));

  const args = parseRkdeveloptoolCommand('rkdeveloptool db loader/MiniLoaderAll.bin');
  const result = await wrapper.runCommand(args);

  assert.deepEqual(capturedArgv, ['db', 'loader/MiniLoaderAll.bin']);
  assert.equal(result.exitCode, 0);

  fs.rmSync(sandboxDir, { recursive: true, force: true });
});

test('runCommand requestDevice uses mocked node-usb in unit test', async () => {
  let capturedArgv = [];
  let getDeviceListCallCount = 0;

  const mockNodeUsb = {
    requestDevice() {
    },
    getDeviceList() {
      getDeviceListCallCount++;
      return [
        {
          deviceDescriptor: {
            idVendor: 0x2207,
            idProduct: 0x350b,
          },
        },
      ];
    },
  };

  const wrapper = await createRKDevelopToolWrapper(createUnitTestWrapperOptions({
    nodeUsb: mockNodeUsb,
    moduleFactory: async () => {
      const mockModule = createMockEmscriptenModule();
      mockModule.callMain = (argv) => {
        capturedArgv = argv;
      };
      return mockModule;
    },
  }));

  const result = await wrapper.runCommand(['ld'], { requestDevice: true });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(capturedArgv, ['ld']);
  assert.equal(getDeviceListCallCount, 1);
});

test('getDevices uses mocked node-usb in unit test', async () => {
  let getDeviceListCallCount = 0;
  const mockDevice = {
    deviceDescriptor: {
      idVendor: 0x2207,
      idProduct: 0x350b,
    },
  };

  const mockNodeUsb = {
    getDeviceList() {
      getDeviceListCallCount++;
      return [mockDevice];
    },
  };

  const wrapper = await createRKDevelopToolWrapper(createUnitTestWrapperOptions({
    nodeUsb: mockNodeUsb,
    moduleFactory: async () => {
      const mockModule = createMockEmscriptenModule();
      mockModule.callMain = () => {};
      return mockModule;
    },
  }));

  const devices = await wrapper.getDevices();

  assert.equal(getDeviceListCallCount, 1);
  assert.equal(Array.isArray(devices), true);
  assert.equal(devices.length, 1);
  assert.equal(devices[0], mockDevice);
});

test('webusb stage: runCommand requests mocked WebUSB device before callMain', async () => {
  let capturedArgv = [];
  const callOrder = [];
  const { webUsb, state } = createMockUsb();
  const originalRequestDevice = webUsb.requestDevice;
  webUsb.requestDevice = async (requestOptions) => {
    callOrder.push('requestDevice');
    return originalRequestDevice(requestOptions);
  };

  const wrapper = await createRKDevelopToolWrapper({
    runtime: 'browser',
    webUsb,
    moduleFactory: async () => {
      const mockModule = createMockEmscriptenModule();
      mockModule.callMain = (argv) => {
        callOrder.push('callMain');
        capturedArgv = argv;
      };
      return mockModule;
    },
  });

  callOrder.push('beforeRun');
  await wrapper.runCommand(['ld'], {
    requestDevice: true,
    usbFilters: [{ vendorId: 0x2207 }],
  });

  assert.deepEqual(capturedArgv, ['ld']);
  assert.equal(state.requestDeviceCallCount, 1);
  assert.deepEqual(state.lastRequestOptions, { filters: [{ vendorId: 0x2207 }] });
  assert.deepEqual(callOrder, ['beforeRun', 'requestDevice', 'callMain']);
});

test('webusb stage: requestDevice rejection stops callMain', async () => {
  let callMainCalled = false;
  const { webUsb, state } = createMockUsb({
    requestDeviceError: new Error('WebUSB permission denied'),
  });

  const wrapper = await createRKDevelopToolWrapper({
    runtime: 'browser',
    webUsb,
    moduleFactory: async () => {
      const mockModule = createMockEmscriptenModule();
      mockModule.callMain = () => {
        callMainCalled = true;
      };
      return mockModule;
    },
  });

  await assert.rejects(
    () => wrapper.runCommand(['ld'], { requestDevice: true }),
    /WebUSB permission denied/
  );

  assert.equal(state.requestDeviceCallCount, 1);
  assert.equal(callMainCalled, false);
});

test('webusb stage: getDevices uses mocked WebUSB list', async () => {
  const mockDevices = [
    { vendorId: 0x2207, productId: 0x350b },
    { vendorId: 0x2207, productId: 0x330c },
  ];
  const { webUsb, state } = createMockUsb({ devices: mockDevices });

  const wrapper = await createRKDevelopToolWrapper({
    runtime: 'browser',
    webUsb,
    moduleFactory: async () => {
      const mockModule = createMockEmscriptenModule();
      mockModule.callMain = () => {};
      return mockModule;
    },
  });

  const devices = await wrapper.getDevices();

  assert.equal(state.getDevicesCallCount, 1);
  assert.deepEqual(devices, mockDevices);
});

test('real flow: ld runs real callMain and only mocks WebUSB', {
  skip: !hasBuiltWasmArtifacts(),
  concurrency: false,
}, async () => {
  console.debug('start ld real flow test');
  await runRealFlowInOrder(async () => {
    const { device, transportState } = createRockusbWebUsbDevice({
      vid: 0x2207,
      pid: 0x320a,
      bcdUsb: 0x0200,
    });
    let runCommandResolved = false;
    let usbEventAfterRunResolved = false;
    const markUsbEvent = () => {
      if (runCommandResolved) {
        usbEventAfterRunResolved = true;
      }
    };

    const originalOpen = device.open.bind(device);
    device.open = async (...args) => {
      markUsbEvent();
      return originalOpen(...args);
    };

    const originalControlTransferIn = device.controlTransferIn.bind(device);
    device.controlTransferIn = async (...args) => {
      markUsbEvent();
      return originalControlTransferIn(...args);
    };

    const { nodeUsb, webUsb, state } = createMockUsb({
      devices: [device],
      requestDeviceResult: device,
    });
    const originalGetDevices = webUsb.getDevices.bind(webUsb);
    webUsb.getDevices = async (...args) => {
      markUsbEvent();
      return originalGetDevices(...args);
    };

    await withMockNavigatorUsb(webUsb, async () => {
      const wrapper = await createRKDevelopToolWrapper({
        runtime: 'node',
        webUsb,
        nodeUsb,
        onStdout: (text) => {
          console.debug(`STDOUT: ${text}\n`);
        },
        onStderr: (text) => {
          console.debug(`STDERR: ${text}\n`);
        },
        onLogWrite: (text) => {
          console.debug(`Log: ${text}`);
        },
      });

      const result = await wrapper.runCommand(['ld'], {
        requestDevice: true,
        usbFilters: [{ vendorId: 0x2207 }],
      });
      runCommandResolved = true;

      assert.equal(typeof result.exitCode, 'number');
      assert.equal(state.requestDeviceCallCount, 0);
      assert.equal(state.getDevicesCallCount, 1);
      assert.equal(transportState.openCallCount > 0, true);
      assert.equal(transportState.controlTransferInCalls.length > 0, true);
      assert.equal(usbEventAfterRunResolved, false);
    });
  });
  console.debug('finish ld real flow test');
});

test('real flow: db loader fixture mounts into VFS before command', {
  skip: !hasBuiltWasmArtifacts(),
  concurrency: false,
}, async () => {
  await runRealFlowInOrder(async () => {
    console.debug('\nflush\n');
    const loaderPath = path.join(projectRoot, 'tests', 'loader', 'MiniLoaderAll.bin');
    assert.equal(fs.existsSync(loaderPath), true, 'loader fixture must exist');
    const { device } = createRockusbWebUsbDevice({
      vid: 0x2207,
      pid: 0x320a,
      bcdUsb: 0x0200,
    });
    const { nodeUsb, webUsb, state } = createMockUsb({
      devices: [device],
      requestDeviceResult: device,
    });

    await withMockNavigatorUsb(webUsb, async () => {
      const wrapper = await createRKDevelopToolWrapper({
        runtime: 'node',
        webUsb,
        nodeUsb,
        onStdout: (text) => {
          console.debug(`STDOUT: ${text}\n`);
        },
        onStderr: (text) => {
          console.debug(`STDERR: ${text}\n`);
        },
        onLogWrite: (text) => {
          console.debug(`Log: ${text}`);
        },
      });
      console.debug('mount MiniLoaderAll.bin\n');

      const mountedPath = await wrapper.mountFile('MiniLoaderAll.bin', loaderPath);
      console.debug('mount MiniLoaderAll.bin done\n');

      assert.match(mountedPath, /^\/tmp\/mounts\/.+\/MiniLoaderAll\.bin$/);

      const result = await wrapper.runCommand(['db', mountedPath], {
        requestDevice: true,
        usbFilters: [{ vendorId: 0x2207 }],
      });

      assert.equal(typeof result.exitCode, 'number');
      assert.equal(state.requestDeviceCallCount, 0);
      assert.equal(state.getDevicesCallCount, 1);
    });
  });
});


test('real flow: wl fw fixture mounts into VFS before command', {
  skip: !hasBuiltWasmArtifacts(),
  concurrency: false,
}, async () => {
  await runRealFlowInOrder(async () => {
    console.debug('\nflush\n');
    const loaderPath = path.join(projectRoot, 'tests', 'fw', 'radxa-e54c-spi-flash-image.img');
    assert.equal(fs.existsSync(loaderPath), true, 'loader fixture must exist');
    const { device } = createRockusbWebUsbDevice({
      vid: 0x2207,
      pid: 0x320a,
      bcdUsb: 0x0200,
    });
    const { nodeUsb, webUsb, state } = createMockUsb({
      devices: [device],
      requestDeviceResult: device,
    });

    await withMockNavigatorUsb(webUsb, async () => {
      const wrapper = await createRKDevelopToolWrapper({
        runtime: 'node',
        webUsb,
        nodeUsb,
        onStdout: (text) => {
          console.debug(`STDOUT: ${text}\n`);
        },
        onStderr: (text) => {
          console.debug(`STDERR: ${text}\n`);
        },
        onLogWrite: (text) => {
          console.debug(`Log: ${text}`);
        },
      });
      console.debug('mount radxa-e54c-spi-flash-image.img\n');

      const mountedPath = await wrapper.mountFile('radxa-e54c-spi-flash-image.img', loaderPath);
      console.debug('mount radxa-e54c-spi-flash-image.img done\n');

      assert.match(mountedPath, /^\/tmp\/mounts\/.+\/radxa-e54c-spi-flash-image\.img$/);

      const result = await wrapper.runCommand(['wl', '0', mountedPath], {
        requestDevice: true,
        usbFilters: [{ vendorId: 0x2207 }],
      });

      assert.equal(typeof result.exitCode, 'number');
      assert.equal(state.requestDeviceCallCount, 0);
      assert.equal(state.getDevicesCallCount, 1);
    });
  });
});
