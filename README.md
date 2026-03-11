# rkdeveloptool port to wasm/webusb

将 `rkdeveloptool` 编译为 WebAssembly，并通过适配层在浏览器（WebUSB）与 Node.js 中复用同一套 CLI 调用方式。

## 环境要求

- Emscripten 3.1.48+
- CMake 3.16+
- Node.js 18+

## 准备
1. 下载并解压 libusb-1.0.29 到 ref，打上 patches/libusb 补丁
2. 拉取 rkdeveloptool ，打上 patches/rkdeveloptool 补丁


## 构建 WASM

```bash
./build_wasm.sh
```

或使用 npm 脚本：

```bash
npm run build:wasm:dev
npm run build:wasm:debug
npm run build:wasm:relwithdebinfo
npm run build:wasm:release
```

构建完成后会在 `dist/` 生成：

- `rkdeveloptool.js`
- `rkdeveloptool.wasm`

默认构建会关闭 JS 混淆（`RK_WASM_JS_MINIFY=0`，内部使用 `--minify 0`），便于排查问题。

如需可调试构建（保留符号并生成 source map），可使用：

```bash
npm run build:wasm:debug
```

等效环境变量：`RK_WASM_BUILD_TYPE=Debug RK_WASM_DEBUG_INFO=1 RK_WASM_JS_MINIFY=0`。

如需发布体积优化版本，可开启 JS 混淆：

```bash
RK_WASM_JS_MINIFY=1 ./build_wasm.sh
```

## Node.js 使用

```bash
npm install
node examples/nodejs/cli.js ld
```

如需在 Node.js 中通过 wrapper 传文件参数，推荐先用本地路径构造 `NodeBlob`（`import { NodeBlob } from './src/node-blob.js'`），再传给 `mountFile()` 或 `runCommand(..., { fileSource })`。

## 浏览器使用

浏览器环境需要 HTTPS 或 localhost。可在仓库根目录启动一个静态服务：

```bash
python3 -m http.server 8080
```

然后访问：

- `http://localhost:8080/examples/browser/index.html`

页面内可：

- 通过 file input 选择固件文件
- 选择 Rockchip 设备（`navigator.usb.requestDevice`）
- 执行 `ld`、`db`、`wl` 等命令

![web](docs/web.png)

## 测试

```bash
npm run test:unit
npm run test:build
```

## 文档

- 迁移说明：`docs/porting-notes.md`
- API 文档：`docs/api.md`

## References

- https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API
- https://wicg.github.io/webusb/
- https://github.com/node-usb/node-usb
- https://web.dev/articles/porting-libusb-to-webusb
- https://github.com/GoogleChromeLabs/web-gphoto2/blob/main/Makefile
- https://developer.mozilla.org/en-US/docs/WebAssembly
- https://opensource.rock-chips.com/wiki_Rkdeveloptool

