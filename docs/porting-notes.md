# rkdeveloptool WebAssembly 迁移说明

## 代码改动摘要

### 1) 平台兼容改动（C++）

- `rkdeveloptool/main.cpp`
  - 在 `__EMSCRIPTEN__` 下不再依赖 `/proc/<pid>/exe`，改为 `getcwd()` 获取工作目录。
  - `readlink()` 路径读取增加长度处理与结尾 `\0` 安全收尾。
  - 日志目录创建统一使用 `mkdir` 返回值检查，并容忍 `EEXIST`。

- `rkdeveloptool/RKScan.cpp`
  - 新增 `rk_usleep()` 包装函数。
  - `__EMSCRIPTEN__` 下将 `usleep()` 替换为 `emscripten_sleep()`，避免阻塞式等待与浏览器运行时冲突。

### 2) 构建链路

- 新增 `build_wasm.sh`
  - 使用 `emconfigure + emmake` 构建 `ref/libusb-1.0.29` 的 wasm 静态库。
  - 使用 `emcmake + cmake --build` 编译 `rkdeveloptool`。

- 新增 `CMakeLists.wasm.txt`
  - 链接 `ref/libusb-1.0.29/build-wasm/lib/libusb-1.0.a`。
  - 输出 `dist/rkdeveloptool.js` 与 `dist/rkdeveloptool.wasm`。

### 3) JavaScript 适配层

- `src/platform-adapter.js`
  - 运行环境识别（browser / node）。
  - 文件选择与 USB 请求入口统一封装。

- `src/fs-wrapper.js`
  - 浏览器：`WORKERFS` 挂载 `File`。
  - Node.js：`NODEFS` 挂载本地目录。
  - 统一 `mountFile(name, source)` 接口。

- `src/usb-adapter.js`
  - 浏览器：WebUSB API。
  - Node.js：`usb`（node-usb）包设备列表与筛选。

- `src/rkdeveloptool-wrapper.js`
  - 暴露 `runCommand(args)`。
  - `FS.chdir('/tmp')`。
  - 对 `/tmp/log` 写入进行回调转发。
  - stdout/stderr 回调透传。

## Emscripten 关键参数

- `-sUSE_PTHREADS=0`：禁用 pthread（当前工具无必需线程能力）。
- `-sALLOW_MEMORY_GROWTH=1`：允许堆扩展，降低大文件内存峰值失败概率。
- `-sWORKERFS=1`：启用浏览器侧文件挂载。
- `-lnodefs.js`：启用 Node.js 侧 `NODEFS` 挂载后端能力。
- `-sFORCE_FILESYSTEM=1`：强制包含 FS 运行时。
- `-sMODULARIZE=1`：导出模块工厂函数。
- `-sEXPORT_ES6=1`：生成 ES Module 形式加载器。
- `-sEXPORT_NAME=createRKDevelopToolModule`：模块工厂函数名。
- `-sINVOKE_RUN=0`：禁止自动执行 `main`，改为 wrapper 通过 `callMain()` 调用。
- `-sEXPORTED_RUNTIME_METHODS=['FS','callMain']`：导出运行时方法。
- `-sEXPORTED_FUNCTIONS=['_main']`：导出主入口符号。
- `RK_WASM_JS_MINIFY=0`（默认）：传 `--minify 0`，关闭 JS 混淆便于调试。
- `RK_WASM_JS_MINIFY=1`：使用 Emscripten 默认压缩/混淆策略，适合发布构建。

## 已知限制

- WebUSB 设备授权必须由用户交互触发，无法后台自动扫描。
- 真实设备时序依赖浏览器实现，少量芯片在低端设备上可能存在超时差异。
- 大固件镜像的稳定性仍取决于浏览器内存策略与 GC 行为。
- 当前测试以 mock 为主，不包含真实硬件自动化测试。
