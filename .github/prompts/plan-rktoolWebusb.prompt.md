# Plan: 将 rkdeveloptool 移植到 Web/WASM

这个方案将 rkdeveloptool 编译为 WebAssembly，通过适配层支持浏览器（WebUSB + File System Access API）和 Node.js 环境，保持原有 CLI 接口不变，最小化代码修改。关键策略是创建平台适配层来隔离环境差异，使用 Emscripten 的 WORKERFS/NODEFS 处理大文件，通过 libusb 的 emscripten_webusb 后端实现 USB 通信。

## Steps

### 1. 创建构建系统配置
   - 在项目根目录创建 `build_wasm.sh` 脚本，配置 Emscripten 工具链
   - 创建 `CMakeLists.wasm.txt`，基于 `rkdeveloptool/CMakeLists.txt` 修改：
     - 指向 `ref/libusb-1.0.29` 并启用 emscripten_webusb 后端
     - 添加 Emscripten 链接标志：`-sUSE_PTHREADS=0 -sALLOW_MEMORY_GROWTH=1 -sEXPORTED_RUNTIME_METHODS=['FS','callMain']`
     - 添加 `-sNODERAWFS=1` 支持 Node.js 文件系统
     - 导出 CLI 接口为 WASM 模块
   - 创建 `patches/rkdeveloptool/002-emscripten-compat.patch`，修复平台相关代码（见步骤2）

### 2. 适配平台相关代码（最小改动）
   - 在 `rkdeveloptool/main.cpp` 中添加条件编译：
     - `#ifdef __EMSCRIPTEN__` 包裹 `/proc/pid/exe readlink` 逻辑，改用 `getcwd()` 或硬编码路径
     - `mkdir` 调用添加 Emscripten FS 检查
   - 在 `rkdeveloptool/RKScan.cpp` 中：
     - `sleep/usleep` 调用改用 `emscripten_sleep()`
   - 使用 quilt 管理 patch 文件，保存到 patches/rkdeveloptool

### 3. 创建平台适配层
   - 创建 `src/platform-adapter.js`，提供统一的平台 API：
     - 检测运行环境（浏览器 vs Node.js）
     - 封装文件系统访问（`showOpenFilePicker` vs `fs` 模块）
     - 封装 USB 设备访问（WebUSB vs node-usb）
   - 创建 `src/fs-wrapper.js`：
     - 浏览器：将 File 对象挂载到 WORKERFS
     - Node.js：使用 NODEFS 挂载本地路径
     - 统一接口：`mountFile(name, source) => virtualPath`
   - 创建 `src/usb-adapter.js`：
     - 浏览器：WebUSB API 转发到 emscripten_webusb
     - Node.js：node-usb 桥接（如需要）

### 4. 构建 WASM 模块和 JS 包装器
   - 执行 `./build_wasm.sh` 编译生成：
     - `dist/rkdeveloptool.wasm` - 核心 WASM 模块
     - `dist/rkdeveloptool.js` - Emscripten 生成的加载器
   - 创建 `src/rkdeveloptool-wrapper.js`：
     - 加载 WASM 模块，初始化 Emscripten 运行时
     - 默认切换到 `/tmp` 目录：`FS.chdir('/tmp')`
     - 实现自定义文件系统，`FS.mount`挂载到`/tmp/log`，所有文件写入操作都直接转发到js回调函数
     - 导出 CLI 接口：`runCommand(args)` 调用编译的 main()
     - 集成 `platform-adapter.js` 和 `fs-wrapper.js`
     - 捕获 stdout/stderr 重定向到 console/回调
   - 创建 `package.json`：
     - 声明 `main: "dist/rkdeveloptool.js"`
     - 依赖：`node-usb`（Node.js）
     - 导出类型定义（TypeScript）

### 5. 实现 CLI 和设备选择器（浏览器）
   - 创建 `examples/browser/index.html`：
     - UI：文件上传区（firmware）、设备选择按钮、命令输入框、输出区
     - 使用 `showOpenFilePicker()` 获取固件文件
     - 调用 `navigator.usb.requestDevice()` 弹出设备选择器（VID: 0x2207 Rockchip）
     - 通过 `rkdeveloptool-wrapper.js` 执行命令，如 `ld`、`db`、`wl`
   - 创建 `examples/nodejs/cli.js`：
     - 解析命令行参数
     - 调用 `rkdeveloptool-wrapper.runCommand(process.argv.slice(2))`
     - 输出到 stdout/stderr

### 6. 构建自动化测试套件
   - 创建 `tests/build.test.js`（编译测试）：
     - 运行 `build_wasm.sh`
     - 检查 `dist/rkdeveloptool.wasm` 和 `.js` 文件生成
     - 验证文件大小和导出符号（wasm-objdump）
   - 创建 `tests/unit/fs-wrapper.test.js`：
     - Mock File 对象，测试 WORKERFS 挂载
     - Mock fs 模块，测试 NODEFS 挂载
     - 验证虚拟路径正确性
   - 创建 `tests/unit/cli-commands.test.js`：
     - Mock USB 设备和文件系统
     - 测试 `ld`（列表设备）、`rfi`（读 flash info）等命令
     - 使用 `libusb` 的 mock 模式或虚拟设备
   - 创建 `tests/integration/mock-device.js`：
     - 模拟 Rockchip 设备响应（USB bulk transfer 数据）
     - 提供测试固件（dummy image）
   - 配置 `package.json` scripts：
     ```json
     {
       "test": "node --test tests/**/*.test.js",
       "test:build": "node tests/build.test.js",
       "test:unit": "node --test tests/unit/*.test.js"
     }
     ```

### 7. 编写文档和示例
   - 更新 `README.md`：
     - 添加 "WebAssembly Build" 章节
     - 说明浏览器和 Node.js 使用方法
     - 链接到 examples 目录
   - 创建 `docs/porting-notes.md`：
     - 记录所有代码修改和原因
     - 列出 Emscripten flags 含义
     - 已知限制（如大文件内存限制）
   - 创建 `docs/api.md`：
     - 文档化 `runCommand(args)` API
     - 参数格式和返回值
     - WebUSB 权限流程

## Verification

### 构建验证
```bash
npm run test:build
# 成功生成 dist/rkdeveloptool.wasm 且大小合理（<5MB）
```

### 单元测试
```bash
npm run test:unit
# 所有文件系统和 CLI 解析测试通过
```

### 浏览器手动测试
- 打开 `examples/browser/index.html`
- 连接 Rockchip 设备，授权 WebUSB 访问
- 执行 `ld` 命令验证设备列表
- 上传小固件执行 `db` 命令验证下载

### Node.js 手动测试
```bash
node examples/nodejs/cli.js ld
# 输出已连接设备信息
```

## Decisions

- **文件系统**：选择 WORKERFS（浏览器）+ NODEFS（Node.js），而非全部加载到 MEMFS，避免内存溢出
- **USB 适配**：依赖 libusb emscripten_webusb 后端，无需重写 RKComm.cpp
- **接口保留**：保持 CLI 接口在 main.cpp，通过 `callMain()` 调用，兼容性最佳
- **测试范围**：不包含真实设备测试，使用 Mock 设备数据验证协议逻辑

## Technical Context

### 代码研究发现

#### libusb 集成
- 所有 libusb 调用集中在 `RKComm.cpp`（CRKUsbComm 类）
- 主要 API：`libusb_init()`, `libusb_open()`, `libusb_claim_interface()`, `libusb_bulk_transfer()`, `libusb_control_transfer()`
- emscripten_webusb 后端已存在于 `ref/libusb-1.0.29/libusb/os/emscripten_webusb.cpp`

#### 文件 I/O 依赖
- 配置文件：`config.ini`、参数文件
- 镜像文件：启动加载程序、固件（可能 100+MB）
- 日志文件：`log/Log<date>.txt`
- 使用 fopen/fread/fseek/fseeko（支持 64 位偏移）

#### 系统依赖
- 无活跃的线程使用（pthread.h 包含但未使用）
- 时间函数：time()、localtime_r()、sleep()、usleep()
- 目录操作：opendir()、readdir()、mkdir()
- 进程信息：readlink("/proc/pid/exe")（Linux 特定）

#### 平台相关代码位置
- `main.cpp:3367` - /proc/pid/exe readlink
- `main.cpp:3395` - mkdir 日志目录
- `RKLog.cpp:82-106` - 日志文件写入
- `RKScan.cpp:417-419, 472` - sleep/usleep 调用

### Emscripten 配置需求
- 版本：3.1.48+（emscripten_webusb 需求）
- 标志：
  - `-sUSE_PTHREADS=0` - 禁用线程（无需使用）
  - `-sALLOW_MEMORY_GROWTH=1` - 允许堆增长（大文件支持）
  - `-sEXPORTED_RUNTIME_METHODS=['FS','callMain']` - 导出文件系统和 main 调用
  - `-sNODERAWFS=1` - Node.js 原始文件系统访问
  - `-sWORKERFS=1` - WebWorker 文件系统（浏览器）

### 已知限制
- WebUSB 需要用户交互确认（无法自动发现设备）
- WASM 堆大小限制（初始 1-2GB，可配置增长）
- 大固件文件需要流式处理或分段加载
- 浏览器异步 Promise 需与 Emscripten 事件循环集成
- 日志输出需要从 stdout/stderr 重定向到 JavaScript 回调
