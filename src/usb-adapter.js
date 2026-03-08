export const ROCKCHIP_USB_FILTERS = [{ vendorId: 0x2207 }];

function isBrowserRuntime(runtime) {
  return runtime === 'browser';
}

function isNodeRuntime(runtime) {
  return runtime === 'node';
}

async function loadNodeUsb() {
  const usbModule = await import('usb');
  return usbModule.usb || usbModule.default || usbModule;
}

export function createUsbAdapter(options = {}) {
  const runtime = options.runtime || 'node';
  const defaultFilters = options.filters || ROCKCHIP_USB_FILTERS;

  async function requestDevice(filters = defaultFilters) {
    if (isBrowserRuntime(runtime)) {
      if (!globalThis.navigator || !globalThis.navigator.usb) {
        throw new Error('WebUSB is not available in this browser context');
      }
      return globalThis.navigator.usb.requestDevice({ filters });
    }

    if (isNodeRuntime(runtime)) {
      const usb = await loadNodeUsb();
      const list = usb.getDeviceList();
      return list.find((device) => {
        if (!device || !device.deviceDescriptor) {
          return false;
        }
        return filters.some((filter) => filter.vendorId === device.deviceDescriptor.idVendor);
      }) || null;
    }

    throw new Error(`Unsupported runtime: ${runtime}`);
  }

  async function getDevices() {
    if (isBrowserRuntime(runtime)) {
      if (!globalThis.navigator || !globalThis.navigator.usb) {
        return [];
      }
      return globalThis.navigator.usb.getDevices();
    }

    if (isNodeRuntime(runtime)) {
      const usb = await loadNodeUsb();
      return usb.getDeviceList();
    }

    return [];
  }

  return {
    requestDevice,
    getDevices,
  };
}
