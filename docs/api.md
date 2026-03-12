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
  - `fileSource?: File/Blob | NodeBlob`
    - 浏览器下传入 `File/Blob`，通过 `WORKERFS` 映射挂载。
    - Node 下统一传入 `NodeBlob`（可由本地路径构造：`new NodeBlob('/path/to/file')`）。
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

- `mountFile(name, source)`
  - 显式挂载文件并返回：
    - `virtualPath`: 挂载后的文件虚拟路径（与旧行为一致）。
    - `mountPoint`: 挂载点路径，可用于后续 `fs.unmount(mountPoint)`。
  - 浏览器与 Node 都通过 `WORKERFS` 文件映射；Node 侧源对象为 `NodeBlob`。

## 浏览器流程建议

1. 用户点击按钮触发 `requestDevice()`。
2. 用户选择固件文件，调用 `mountFile()` 或通过 `runCommand(..., { fileSource })` 自动挂载。
3. 调用 `runCommand(['db', '$FILE'], { replaceToken: '$FILE' })`。

## Node.js 流程建议

1. 创建 wrapper（`runtime: 'node'`）。
2. 需要文件参数时，先由路径构造 `NodeBlob`。
3. 通过 `mountFile()` 或 `runCommand(..., { fileSource })` 使用该 `NodeBlob`。
4. 根据 `exitCode` 设置进程退出码。
