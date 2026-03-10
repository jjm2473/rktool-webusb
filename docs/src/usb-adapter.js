export const ROCKCHIP_USB_FILTERS = [{ vendorId: 0x2207 }];

function isBrowserRuntime(runtime) {
  return runtime === 'browser';
}

function isNodeRuntime(runtime) {
  return runtime === 'node';
}

async function resolveWebUsb(options = {}) {
  if (options.webUsb) {
    return options.webUsb;
  }

  const runtime = options.runtime || 'node';
  if (isNodeRuntime(runtime)) {
    const usbModule = await import('usb');
    // Expose WebUSB adapter to global navigator object so libusb can access it
    if (typeof globalThis !== 'undefined') {
      if (!globalThis.navigator) {
        globalThis.navigator = {};
      }
      globalThis.navigator.usb = usbModule.getWebUsb();
    }
  }

  if (globalThis.navigator && globalThis.navigator.usb) {
    return globalThis.navigator.usb;
  }

  return null;
}

export async function createUsbAdapter(options = {}) {
  const defaultFilters = options.filters || ROCKCHIP_USB_FILTERS;
  const webUsb = await resolveWebUsb(options);

  async function requestDevice(filters = defaultFilters) {
    if (!webUsb) {
      throw new Error('WebUSB is not available in this browser context');
    }
    return webUsb.requestDevice({ filters });
  }

  async function getDevices() {
    return webUsb.getDevices();
  }

  return {
    requestDevice,
    getDevices,
  };
}
