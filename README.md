# DSH WebTokens · DeepSeek 网页桥接

把已登录的 DeepSeek 网页接入 **DeepSeek Harness（DSH）** 的模型菜单，让 Harness 在本机完成工具调用、多轮任务、验证与修复。

本仓库是第三方桥接插件。稳定核心来自 `82440ec209d50d5e8063119cc5e19c84ac9f0ebc`，DSH 插件 **0.2.15**，Chrome 扩展 **0.2.19**。仅支持 DeepSeek 网页，不包含后续豆包实验代码。

## 安装

需要 Node.js 24+、pnpm、Chrome，以及可以正常登录使用的 DeepSeek 网页账号。已验证的 DSH CLI 版本为 `0.1.5-rc.1`。下列命令在终端执行。

如果尚未安装 DSH：

```sh
npm install -g pnpm @deepseek-ai/dsh@0.1.5-rc.1
```

通过 DSH 官方插件入口安装本仓库：

```sh
dsh plugin --profile web add "git+https://github.com/xinyuquan985-coder/DSH-webtokens.git#v0.2.15-deepseek"
dsh plugin --profile web exec dsh-web-bridge setup
```

`setup` 会输出一个 **Chrome 扩展目录**，并在当前 DSH profile 内生成本机配对密钥和配置。保留这份目录，不要删除。它位于 profile 的 `web-bridge/chrome` 下，不是仓库中的 `extension` 目录，也不是 `node_modules` 中的目录。

已有 DSH 的用户应在准备使用的 profile 中安装。如果不是 `web`，请在安装、setup、启动命令中统一替换 profile 名称。手工配置过旧桥接的用户应先备份并迁移旧条目；setup 检测到重复条目会停止，不会替你删除。

## Chrome 插件怎么用

1. 在 Chrome 打开 `chrome://extensions`，打开右上角 **开发者模式**。
2. 点击 **加载已解压的扩展程序**，选择上一步 setup 输出的 `web-bridge/chrome` 目录。
3. 确认卡片名称为 **DeepSeek Harness 网页桥接**，版本 **0.2.19**。同一个 Chrome 用户配置中只加载一份已配对的扩展。
4. 在这个 Chrome 用户配置中打开 [DeepSeek 网页](https://chat.deepseek.com/)，完成登录。
5. 启动 DSH；若安装前已经启动，先结束旧 DSH 进程，再重新启动：

```sh
dsh web
```

6. 在 Harness 输入框的模型菜单中选择 **DeepSeek 网页**（`deepseek-web`），再发送任务。不要误选需要 API 配置的 DeepSeek 型号。
7. 保持 Chrome 运行。扩展自动使用专用网页会话，接收并回传回答；Harness 负责执行本机工具。不要在工作中的专用会话里手动输入或删除消息。
8. Harness 的 **网页桥接** 面板可查看阶段、推理进度和结果。需要查看实际网页时，点击 **查看网页**，也可以使用 Chrome 扩展弹窗的 **打开桥接网页**。

首次建议用一个测试目录发任务：“读取 test.txt，原样复制为 test-copy.txt，再读取副本核对。”检查真实文件和工具执行记录，确认完整链路。

连接检查：

```sh
dsh plugin --profile web exec dsh-web-bridge doctor
```

`paired: true` 表示本地配对成功；`connected: true` 表示 Chrome 已连接。若 Chrome 尚未连接，doctor 返回退出码 2。该命令不打印密钥。

## 工作方式

```text
Harness 用户任务与工具定义
          ↓
DSH 模型适配器 → 本机桥接 127.0.0.1:3081
          ↓
Chrome 扩展 → 已登录的 DeepSeek 网页
          ↓
回答校验 → Harness 原生工具调用 → 实际工具结果 → 下一轮
```

- **多轮执行：** 网页返回结构化调用，桥接验证请求标识、工具名称和参数，然后交给 Harness 原生工具系统执行。结果进入下一轮上下文。
- **验证和修复：** 协议格式错误最多请求模型纠正一次；不会猜测缺失参数或自行拼接执行命令。工具执行结果由 Harness 回传，模型据此继续检查和修复任务；不保证任何任务都自动成功。
- **长任务续接：** 按网页实际传输预算分段摘要，保留近期上下文与结果；会话容量不足时切换网页会话，并携带经校验的摘要继续。
- **代码传输：** `DSH_CALLS`、`DSH_BODY` 是本插件定义的传输协议，不是 DeepSeek 官方 API 字段，用于完整保留大段文件正文和转义符。
- **职责划分：** 插件注册、任务循环、本机工具、权限管理、会话等由官方 Harness 提供；网页调度、内容采集、传输协议、校验、分段续接和桥接面板由本插件实现。

浏览器网页自身的模型选择、登录验证、限额与服务可用性仍由 DeepSeek 决定。本插件不提供 API Key，也不解锁网页账号没有的模型。

## 更新与排障

更新到指定版本后，再执行一次 setup，然后在 Chrome 扩展卡片上点击 **重新加载**。已打开的旧专用网页需要刷新；先等当前任务结束，再更新。

- **找不到“DeepSeek 网页”：** 确认安装与启动的是同一个 profile，重启 DSH，检查启动错误。setup 本身不会切换默认模型。
- **找不到插件命令：** 确认前面的 add 成功，且通过 `dsh plugin --profile web exec ...` 运行。
- **3081 端口被占用／配对失败：** 检查是否有另一个 DSH 桥接实例正在运行。本基线扩展固定连接本机 3081，同时只运行一套桥接服务。
- **等待扩展连接：** 确认加载了 setup 输出的目录、Chrome 正在运行、扩展未关闭。直接加载仓库 extension 目录会缺少配对文件。
- **网页等待登录／验证：** 点击查看网页，手动完成登录或验证，再按界面提示继续或重新提交失败任务。
- **后台停滞：** 点击查看网页确认实际进度；不要重复手动发送输入框内容。网页改版可能需要更新适配。
- **参数或正文校验失败：** 查看面板中的具体错误。插件会停止不确定调用，不会把未验证的内容当作成功结果。

日志保存在 profile 的 `web-bridge/logs/events.jsonl`。密钥、`local-config.json`、profile 配置和日志属于本机文件，不要上传到公开仓库。发到 DeepSeek 的上下文包含任务所需的文件内容和工具结果，因此只在适合发送给该网页服务的项目中使用。

## 源码与验证

`SOURCE.json` 记录来自指定提交的 43 个核心、扩展与回归测试文件的 SHA-256。新增加的内容是根目录安装包元数据、setup/doctor、安装测试和公开文档；未改写基线核心文件。

```sh
npm install
npm test
npm run verify:source
npm pack
```

实际安装与运行检查见 [VERIFICATION.md](VERIFICATION.md)。
