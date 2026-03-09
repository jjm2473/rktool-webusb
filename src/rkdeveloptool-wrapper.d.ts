export type RuntimeType = 'browser' | 'node' | 'unknown';

export interface RunCommandOptions {
  requestDevice?: boolean;
  usbFilters?: Array<{ vendorId?: number; productId?: number }>;
  fileSource?: unknown;
  fileName?: string;
  replaceToken?: string;
}

export interface RunCommandResult {
  exitCode: number;
}

export interface RkdeveloptoolWrapper {
  runtime: RuntimeType;
  module: unknown;
  platform: unknown;
  fs: unknown;
  requestDevice(filters?: Array<{ vendorId?: number; productId?: number }>): Promise<unknown>;
  getDevices(): Promise<unknown[]>;
  pickFirmwareFile(): Promise<File>;
  mountFile(name: string, source: unknown): Promise<string>;
  runCommand(args: string[], options?: RunCommandOptions): Promise<RunCommandResult>;
}

export interface WrapperCreateOptions {
  runtime?: RuntimeType;
  moduleUrl?: string;
  wasmUrl?: string;
  moduleFactory?: (options?: unknown) => Promise<unknown>;
  fsOptions?: Record<string, unknown>;
  usbFilters?: Array<{ vendorId?: number; productId?: number }>;
  nodeUsb?: { getDeviceList(): unknown[] };
  loadNodeUsb?: () => unknown | Promise<unknown>;
  webUsb?: {
    requestDevice(options: { filters: Array<{ vendorId?: number; productId?: number }> }): Promise<unknown>;
    getDevices(): Promise<unknown[]>;
  };
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
  onLogWrite?: (text: string) => void;
}

export function createRKDevelopToolWrapper(options?: WrapperCreateOptions): Promise<RkdeveloptoolWrapper>;
