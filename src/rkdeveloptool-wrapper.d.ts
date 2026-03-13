import { RkfwInfo } from "./rkfw"

export type RuntimeType = 'browser' | 'node' | 'unknown';

export interface BlobLikeSource {
  name?: string;
  size?: number;
  lastModifiedDate?: Date;
  slice(start?: number, end?: number, contentType?: string): unknown;
}

export interface NodeBlobLike extends BlobLikeSource {
  lastModified?: number;
  type?: string;
  arrayBuffer?(): Promise<ArrayBuffer>;
  text?(): Promise<string>;
  bytes?(): Promise<Uint8Array>;
  stream?(): unknown;
}

export type FileSource = BlobLikeSource | NodeBlobLike;

export interface RunCommandOptions {
  requestDevice?: boolean;
  usbFilters?: Array<{ vendorId?: number; productId?: number }>;
  fileSource?: FileSource | string;
  gunzip?: boolean;
  fileName?: string;
  replaceToken?: string;
}

export interface RunCommandResult {
  exitCode: number;
}

export interface MountFileResult {
  virtualPath: string;
  mountPoint: string;
}

export interface Rkfw {
  source: FileSource;
  meta: RkfwInfo;
}

export interface RkfwVfs {
  mountPoint: string;
  meta: RkfwInfo;
}

export type RkObjectType = 'idb' | 'gpt' | 'parm' | 'parts' | 'part';
export type FlashingState = 'start' | 'successed' | 'failed' | 'skipped';

export interface RkfwFlashStage {
  type: RkObjectType;
  /*
   * only avaliable on 'part' type
   */
  object: string;
  state: FlashingState;
}

export interface RkdeveloptoolWrapper {
  runtime: RuntimeType;
  module: unknown;
  platform: unknown;
  fs: unknown;
  requestDevice(filters?: Array<{ vendorId?: number; productId?: number }>): Promise<unknown>;
  getDevices(): Promise<unknown[]>;
  mountFile(name: string, source: FileSource | string | Rkfw, gunzip?: boolean, rkfw?: boolean): Promise<MountFileResult>;
  umount(mountPoint: string): void;
  runCommand(args: string[], options?: RunCommandOptions): Promise<RunCommandResult>;
  flashRKFW(rkfwVfs: RkfwVfs, onStage?: (stage: RkfwFlashStage) => Promise<void>): Promise<RunCommandResult>;
}

export interface WrapperCreateOptions {
  runtime?: RuntimeType;
  moduleUrl?: string;
  wasmUrl?: string;
  moduleFactory?: (options?: unknown) => Promise<unknown>;
  fsOptions?: Record<string, unknown>;
  usbFilters?: Array<{ vendorId?: number; productId?: number }>;
  webUsb?: {
    requestDevice(options: { filters: Array<{ vendorId?: number; productId?: number }> }): Promise<unknown>;
    getDevices(): Promise<unknown[]>;
  };
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
  onLogWrite?: (text: string) => void;
}

export function createRKDevelopToolWrapper(options?: WrapperCreateOptions): Promise<RkdeveloptoolWrapper>;
