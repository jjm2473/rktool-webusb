const DEFAULT_FLASH_INFO = new Uint8Array([
  0x52, 0x4b, 0x46, 0x4c,
  0x41, 0x53, 0x48, 0x21,
]);

export class MockRockchipDevice {
  constructor(options = {}) {
    this.vid = options.vid || 0x2207;
    this.pid = options.pid || 0x350b;
    this.responses = new Map();
    this.responses.set('rfi', options.flashInfo || DEFAULT_FLASH_INFO);
  }

  setResponse(command, payload) {
    this.responses.set(command, new Uint8Array(payload));
  }

  async controlTransferOut(_setup, _data) {
    return { status: 'ok', bytesWritten: 0 };
  }

  async bulkTransferOut(_endpointNumber, data) {
    this.lastCommand = this.decodeCommand(data);
    return { status: 'ok', bytesWritten: data?.byteLength || 0 };
  }

  async bulkTransferIn(_endpointNumber, length) {
    const payload = this.responses.get(this.lastCommand || 'rfi') || new Uint8Array(length);
    return {
      status: 'ok',
      data: new DataView(payload.buffer, payload.byteOffset, Math.min(payload.byteLength, length)),
    };
  }

  decodeCommand(data) {
    if (!data) {
      return '';
    }
    const bytes = new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength || data.length || 0);
    const text = new TextDecoder().decode(bytes).trim().toLowerCase();
    if (text.includes('rfi')) {
      return 'rfi';
    }
    if (text.includes('ld')) {
      return 'ld';
    }
    return text;
  }
}

export function createDummyFirmware(size = 1024) {
  const data = new Uint8Array(size);
  for (let i = 0; i < data.length; i++) {
    data[i] = i & 0xff;
  }
  return data;
}
