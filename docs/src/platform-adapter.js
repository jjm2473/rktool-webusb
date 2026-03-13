import { createFsWrapper } from './fs-wrapper.js?v=768a1bd';
import { createUsbAdapter, ROCKCHIP_USB_FILTERS } from './usb-adapter.js?v=768a1bd';

export function detectRuntime() {
  if (typeof window !== 'undefined' && typeof window.document !== 'undefined') {
    return 'browser';
  }

  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    return 'node';
  }

  return 'unknown';
}

export async function createPlatformAdapter(options = {}) {
  const runtime = options.runtime || detectRuntime();
  const usbFilters = options.usbFilters || ROCKCHIP_USB_FILTERS;
  const usbAdapter = await createUsbAdapter({
    runtime,
    filters: usbFilters,
    webUsb: options.webUsb,
  });

  async function createFileSystem(moduleInstance, fsOptions = {}) {
    return await createFsWrapper(moduleInstance, {
      runtime,
      ...fsOptions,
    });
  }

  return {
    runtime,
    usbFilters,
    createFileSystem,
    requestDevice: usbAdapter.requestDevice,
    getDevices: usbAdapter.getDevices,
  };
}
