# rkdeveloptool port to wasm/webusb

将 `rkdeveloptool` 编译为 WebAssembly，并通过适配层在浏览器（WebUSB）与 Node.js 中复用同一套 CLI 调用方式。

## 环境要求

- Emscripten 3.1.48+
- CMake 3.16+
- Node.js 18+

## 构建 WASM

```bash
./build_wasm.sh
```

构建完成后会在 `dist/` 生成：

- `rkdeveloptool.js`
- `rkdeveloptool.wasm`

## Node.js 使用

```bash
npm install
node examples/nodejs/cli.js ld
```

## 浏览器使用

浏览器环境需要 HTTPS 或 localhost。可在仓库根目录启动一个静态服务：

```bash
python3 -m http.server 8080
```

然后访问：

- `http://localhost:8080/examples/browser/index.html`

页面内可：

- 选择固件文件（`showOpenFilePicker`）
- 选择 Rockchip 设备（`navigator.usb.requestDevice`）
- 执行 `ld`、`db`、`wl` 等命令

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

