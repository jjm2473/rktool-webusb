# rkdeveloptool-wrapper API

## 创建实例

```js
import { createRKDevelopToolWrapper } from '../src/rkdeveloptool-wrapper.js';

const wrapper = await createRKDevelopToolWrapper({
  runtime: 'browser',
  onStdout: (line) => console.log(line),
  onStderr: (line) => console.error(line),
  onLogWrite: (text) => console.log(text),
});
```

## `runCommand(args, options)`

执行编译后的 `main()`，保持原生 CLI 参数语义。

### 参数

- `args: string[]`
  - 例如：`['ld']`、`['db', '/tmp/loader.bin']`

- `options?: RunCommandOptions`
  - `requestDevice?: boolean`
    - 为 `true` 时先触发设备请求（浏览器）或筛选设备（Node）。
  - `usbFilters?: Array<{ vendorId?: number; productId?: number }>`
    - 默认使用 Rockchip `vendorId=0x2207`。
  - `fileSource?: unknown`
    - 浏览器下传入 `File/Blob`，通过 `WORKERFS` 映射挂载。
    - Node 下传入本地文件路径字符串，通过 `NODEFS` 映射挂载。
    - 不再回退到 `MEMFS writeFile` 内存写入。
  - `fileName?: string`
    - 虚拟挂载名称提示。
  - `replaceToken?: string`
    - 当 `args` 中出现该 token（例如 `$FILE`）时，替换为挂载后的虚拟路径。

### 返回值

```ts
{
  exitCode: number;
  stdout: string;
  stderr: string;
}
```

## 其他方法

- `requestDevice(filters?)`
  - 手动请求 USB 设备授权。

- `getDevices()`
  - 获取已授权/可见设备列表。

- `pickFirmwareFile()`
  - 浏览器下调用 `showOpenFilePicker()` 并返回 `File`。

- `mountFile(name, source)`
  - 显式挂载文件并返回虚拟路径。
  - 浏览器必须可用 `WORKERFS`，Node.js 必须可用 `NODEFS`；不可用时会抛错。

## 浏览器流程建议

1. 用户点击按钮触发 `requestDevice()`。
2. 用户选择固件文件，调用 `mountFile()` 或通过 `runCommand(..., { fileSource })` 自动挂载。
3. 调用 `runCommand(['db', '$FILE'], { replaceToken: '$FILE' })`。

## Node.js 流程建议

1. 创建 wrapper（`runtime: 'node'`）。
2. 通过 `runCommand(process.argv.slice(2))` 直接转发参数。
3. 根据 `exitCode` 设置进程退出码。
