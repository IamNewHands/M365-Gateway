# AI 部署与维护说明

## 唯一工作目录

所有修改、升级、测试、打包和部署只能在以下目录执行：

```text
C:\Users\exampleuser\Desktop\开源\M365-Gateway-CF2
```

任何 AI 或人工操作开始前必须先读取本包实际存在的 `CONFIGURATION.md`、`README.md`、`SECURITY.md` 和 `RELEASE.json`。不得从旧目录复制单个文件覆盖本目录，也不得引用不存在的来源清单作为部署证据。

## 修改流程

1. 进入唯一工作目录，确认没有 `.dev.vars`、Token、密码或 API Key 被纳入修改。
2. 只修改与当前问题有关的源码与测试；先补回归测试，再修实现。
3. 运行 `npm ci`（依赖未安装或 lockfile 变化时）。
4. 运行完整门禁：

   ```powershell
   npm run check
   ```

5. `check` 必须完整结束并返回 0。只看到 TypeScript、ESLint 或 Vitest 开始运行，不等于通过。
6. 真实客户端测试按 Codex → OpenCode → Hermes → Claude 顺序单独运行。严禁同时运行，避免 CF 免费资源和 Microsoft 账号风控叠加；Reasonix、Pi Agent、ZCode 未安装时只做协议验收。
7. 生产部署前再次确认账号、Worker、KV 和域名均与 `CONFIGURATION.md` 一致。

## 更新 CF2

仅在完整检查通过后执行：

```powershell
$env:XDG_CONFIG_HOME='C:\Users\exampleuser\AppData\Roaming\wrangler-cf2'
$env:M365_COMPACTION_ENCRYPTION_KEY='<从密码管理器读取的跨CF共享base64url密钥>'
node .\deploy-cloudflare.mjs --update --sync-compaction-key --yes --account-id 00000000000000000000000000000000 --name m365-gateway-native-preview --client-id 00000000-0000-4000-8000-000000000001 --kv-id REPLACE_WITH_KV_NAMESPACE_ID --domain gateway.example.com
```

部署器会：

- 锁定指定 Cloudflare 账号；
- 校验现有 KV 和必要 Secret；
- 记录部署前版本；
- 上传新版本；
- 检查 `/api/health` 与实际版本；
- 健康检查失败时自动回滚到先前版本。

不得用裸 `wrangler deploy` 绕过这些保护。需要 R2 冷归档时，先在同一 CF2 账号创建桶，再额外传入 `--archive-bucket <桶名>`；不要为启用 R2 改动主链路。

管理员遗失现有后台密码时，使用更新模式的 `--reset-admin-password`，并仅在当前进程的 `M365_ADMIN_PASSWORD` 中提供新值。部署器会上传新的引导密码和一次性恢复版本；Tenant Durable Object 只重写管理员密码哈希、清除旧后台会话与登录失败计数，不删除账号、OAuth、API Key 或聊天状态。禁止把密码写进命令参数、配置文件或本文档。

## 部署后验证

1. 确认部署器报告的新 version ID。
2. 访问 `https://gateway.example.com/api/health`，确认 HTTP 200 且返回版本与新版本一致。
3. 单独验证 `/v1/models`、非流式文本、流式文本、Responses 工具调用和续接。
4. 依次单独运行 Codex、OpenCode、Hermes、Claude 的真实小任务；一个完成并保存报告后再运行下一个。
5. 执行 `npx wrangler deployments list --json`，保存新 version ID，并核对健康响应中的 `X-M365-Worker-Version`。
6. 只有线上版本和真实客户端验收完成后才更新 `RELEASE.json`；本地候选不得声明为生产制品等价。

## 长任务专项验收

长任务必须覆盖以下场景：

- 上下文压缩后仍保留用户目标、路径、服务器编号和未完成步骤；
- 工具调用完成后不重复发送完全相同的调用；
- 工具不可用或返回无效载荷时，改换参数/路径，不循环重试；
- 客户端本地工具调用保持原生 tool call，不被改造成 ChatHub 托管链接；
- `previous_response_id`、compaction capsule、断线续接和“已有活动请求”能正确收敛；
- 不把“命令已回显”误判成“命令已成功执行”；
- 没有成功工具证据时不声明部署、写入或测试完成。

## 回滚

部署器自动回滚失败时，使用清单中的 `rollbackVersionId`，并先确认账号和 Worker：

```powershell
npx wrangler rollback a2a501ab-bfa7-4628-922d-28e34a127ec3 --name m365-gateway-native-preview --yes
```

回滚后仍要检查 `/api/health` 并重新拉取线上产物。不要用旧源码目录覆盖本目录作为“回滚”。
