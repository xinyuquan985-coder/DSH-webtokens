# 发布验证记录

验证日期：2026-09-15。

## 版本与范围

- 指定源提交：`82440ec209d50d5e8063119cc5e19c84ac9f0ebc`。
- DSH 插件核心：0.2.15；打包的 Chrome 扩展：0.2.19。
- 核心、扩展及保留的回归测试共 43 个文件，SHA-256 全部与源提交一致，见 SOURCE.json。
- 新增部分：根安装包元数据、setup/doctor、本机配对与配置生成、安装回归测试、公开文档。
- 不包含后续豆包适配，也不包含原实验项目的官方 UI 补丁、生成作品或个人运行配置。

## 自动验证

在发布目录独立安装依赖后执行：

```sh
pnpm install
node --test tests/*.test.mjs
node scripts/verify-source.mjs
pnpm pack
```

**86 项测试通过，0 失败。** 其中 84 项为源提交的桥接回归，2 项为新增安装测试。覆盖正文与转义传输、调用批次校验、消息归属、格式修复上限、摘要与续接、取消与超时、后台渲染、进度面板、配对配置以及安装幂等性。

原实验项目的 2 项“产物目录”测试依赖额外官方 UI 修改，不属于此插件，未纳入发布包。

## DSH 官方入口安装验证

环境：Windows、Node.js 24.19.0、DSH CLI 0.1.5-rc.1，核心依赖锁定结果见 pnpm-lock.yaml。

使用全新的 DSH_HOME/profile，通过官方 `dsh plugin --profile web add <tarball>` 安装本仓库生成的包，再执行 `dsh plugin --profile web exec dsh-web-bridge setup`：

- 安装成功；DSH 自动把 `dsh-web-bridge` 注册进 profile 的 bundles。
- setup 生成本机密钥、配对 Chrome 目录及配置；重复运行保留原密钥和其他模型设置。
- 配置合成成功。
- 独立端口启动成功；桥接返回核心版本 0.2.15，配对认证通过。
- Harness 网页桥接面板返回 HTTP 200。
- Harness 原生模型选择接口成功选择 `deepseek-web / deepseek-web`。

## 真实网页多轮验收

为了不打断用户已有 DSH 与已登录的 Chrome，先独立验证发布包的普通服务模式，再让同一发布包使用其已有的 remote 模式连接当前空闲的 DeepSeek 桥接通道。没有重载或替换正在使用的 Chrome 扩展。

新安装包在隔离 Harness 工作区执行：

1. read 读取包含随机标记、中文、美元符号、引号、Windows 路径和末尾换行的 source.txt。
2. 根据真实读取结果，用 write 原样写入 copy.txt。
3. read 复读副本，返回核对结果与 `731 × 7 = 5117`。

检查结果：

| 项目 | 结果 |
| --- | --- |
| 实际工具顺序 | read → write → read |
| 工具结果 | 3 项，均无错误 |
| 副本字节内容 | 与源文件完全一致 |
| 源文件哈希 | 未改变 |
| 网页请求 | 4 次，全部完成 |
| 重复发送／失败事件 | 0 |
| Harness 回合状态 | 正常结束 |
| 最终回答 | 含“运行验证完成”和 5117 |

该验收证实新安装包可参与真实 Harness 与网页工具循环；Chrome 通道报告 DeepSeek worker 0.2.19。此次未在另一个全新 Chrome 用户配置中重做登录和扩展加载，也未重复测试所有网站交互。网页改版、账号状态和限额仍可能影响运行。
