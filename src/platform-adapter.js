import { createFsWrapper } from './fs-wrapper.js';
import { createUsbAdapter, ROCKCHIP_USB_FILTERS } from './usb-adapter.js';

export function detectRuntime() {
  if (typeof window !== 'undefined' && typeof window.document !== 'undefined') {
    return 'browser';
  }

  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    return 'node';
  }

  return 'unknown';
}

export function createPlatformAdapter(options = {}) {
  const runtime = options.runtime || detectRuntime();
  const usbFilters = options.usbFilters || ROCKCHIP_USB_FILTERS;
  const usbAdapter = createUsbAdapter({ runtime, filters: usbFilters });

  async function pickFile() {
    if (runtime === 'browser') {
      if (!globalThis.showOpenFilePicker) {
        throw new Error('showOpenFilePicker is not available in this browser');
      }
      const handles = await globalThis.showOpenFilePicker({
        multiple: false,
      });

      if (!handles.length) {
        throw new Error('No file selected');
      }

      return handles[0].getFile();
    }

    throw new Error('pickFile() is only available in browser runtime');
  }

  function createFileSystem(moduleInstance, fsOptions = {}) {
    return createFsWrapper(moduleInstance, {
      runtime,
      ...fsOptions,
    });
  }

  return {
    runtime,
    usbFilters,
    pickFile,
    createFileSystem,
    requestDevice: usbAdapter.requestDevice,
    getDevices: usbAdapter.getDevices,
  };
}
