# CF2 配置基准

本目录是 CF2 的唯一维护源码。不得从桌面旧压缩包、旧分析目录或其他 Cloudflare 账号的 Worker 继续修改。

## 生产身份

| 项目 | 固定值 |
| --- | --- |
| Cloudflare 账号 | CF2 |
| 登录邮箱 | `operator@example.com` |
| Account ID | `00000000000000000000000000000000` |
| Worker | `m365-gateway-native-preview` |
| 生产域名 | `gateway.example.com` |
| Entra Client ID | `00000000-0000-4000-8000-000000000001` |
| KV binding | `SENSITIVE_KV` |
| KV namespace ID | `REPLACE_WITH_KV_NAMESPACE_ID` |
| Durable Objects | `TENANTS` / `CHATS` / `INFERENCE` |

生产 Microsoft 365 scope：

```text
openid profile offline_access https://substrate.office.com/sydney/M365Chat.Read https://substrate.office.com/sydney/sydney.readwrite
```

## Secret 边界

下列值只能保存在 Cloudflare Secret 或临时进程环境中，不得写入源码、Markdown、日志、报告或压缩包：

- `DATA_ENCRYPTION_KEY`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `BOOTSTRAP_GATEWAY_API_KEY`
- Microsoft OAuth access/refresh token
- Wrangler OAuth token / Cloudflare API token
- 客户端完整 API Key

更新 CF2 时必须复用原来的 `SENSITIVE_KV` 和 `DATA_ENCRYPTION_KEY`。更换其中任意一个都会导致已有 OAuth 密文不可读取。

## 存储与资源职责

- Worker 入口：`/v1/*` 推理请求原样流式转发到 `INFERENCE`；不解析大请求、不处理 SSE。GET `/v1/models`、健康检查、后台和静态资源保持原路径。
- `INFERENCE`：每个 HTTP 推理请求独立的无业务存储 Durable Object，执行鉴权、请求解析、上下文/工具适配和流式统计；不改变模型、工具参数、客户端配置或会话身份。
- Durable Object SQLite：账号、会话、工具调用账本和长任务热状态的强一致权威副本。
- KV：OAuth 密文镜像和退避恢复，不是请求热路径。
- Static Assets：管理页面静态资源由 Cloudflare Assets 边缘直出。
- R2：可选的加密冷归档；不绑定也不影响主流程。禁止在每次请求中读取 R2。
- Smart Placement：仅用于动态 Worker；上线后按真实延迟数据决定是否保留。

`v2` 迁移只增加 `InferenceGateway` 类，不删除或重建 `TENANTS`、`CHATS`。Durable Object 默认 CPU 预算为每次调用 30 秒，与免费入口 Worker 的 10 ms 不同；这不是解除所有额度限制。DO 的请求数、运行时长和存储仍有套餐限额，必须监测，不能保证无限免费负载。

## 图片请求预算

`/v1/responses`（含 `/compact`）、Chat Completions 和 Messages 的 JSON 请求体上限统一为 8 MiB，按传输字节计算，包含 Base64、对话和工具定义。图片转 Base64 后约增加三分之一大小。Responses/Chat 的内联图片仍单张最多 4 MiB、合计最多 6 MiB、最多 8 张，且必须同时满足 8 MiB 总请求限制；这些是网关限制，不代表上游识图能力保证。带 Content-Length 和分块上传均执行有界读取。超限响应中的大小直接取自实际配置，避免错误提示与行为不一致。

## 本地配置

### Responses 自然语言与工具边界

Responses 顶层 `instructions`、当前 `input`、可携带会话历史和调用方声明的
`tools` 必须作为同一次模型决策的上下文进入 Microsoft 365。Gateway 只添加内部
角色边界并转义伪造的协议标记，不按“继续”“部署”“登录”等词语选择固定动作，
不改写用户自然语言，也不替模型编造工具参数。工具执行结果仍由客户端通过
`function_call_output` 回传，再由同一任务上下文决定下一步。

当前明确转换的 Responses 控制项包括 `model`、`input`、`instructions`、`tools`、
`tool_choice`、`previous_response_id`、会话标识、`reasoning.effort` 和受支持的压缩续接。
`reasoning.summary=auto/concise/detailed` 选择输出上游已有的公开摘要；它不是
开启微软隐藏推理的参数。`none` 或未请求摘要时不输出。`text.verbosity`、采样参数
以及 OpenAI 托管工具等没有等价的 Microsoft ChatHub 能力；可兼容接收这些字段，
但不得声称已经实现其上游语义，也不得生成虚假的推理正文。

### 思考模式兼容边界

Responses 使用 `reasoning.effort`，Chat Completions 使用 `reasoning_effort`。
Messages 的 `thinking.type=enabled/adaptive` 现在映射到现有深度思考 tone；
`thinking.type=disabled` 映射为 `none`。`output_config.effort` 会参与选择，
但显式开启 thinking 时，`low` 仍进入深度路由。未提供这些字段保持原默认行为。
显式 `*-reasoning` 模型始终进入深度路由，即使传入 `none`；需要关闭时使用基础模型。

这只是现有 ChatHub 快速/深度路由兼容，不保证逐档算力、Anthropic 的精确
`budget_tokens` 或自适应行为。Gateway 不生成虚构的 thinking 内容、签名或推理摘要。
`/v1/models` 和 Codex 目录共用档位元数据；标准列表中的额外字段不会强制客户端显示控件。

OpenCode 自定义 provider 可在其已有模型配置下合并下列 variants（保留 provider 名、
API 地址和密钥；这里只提供配置示例，不修改本地客户端）：

```json
{
  "gpt-5.6-sol": {
    "variants": {
      "fast": { "reasoningEffort": "low" },
      "thinking": { "reasoningEffort": "high" }
    }
  }
}
```

这是通过 OpenAI 兼容 provider 发送参数的配置。通过 Anthropic provider 时使用
`thinking: { "type": "enabled", "budgetTokens": 16000 }`，由 SDK 转换为 Messages 字段。
界面是否显示思考正文，取决于上游是否返回真实摘要以及客户端是否支持，不能由档位名称推断。

### 公开思考摘要验收（2026-09-06）

- 只接受微软公开的 `Progress / ChainOfThoughtSummary` 文本，不输出隐藏推理、
  内部调试内容，不用工具活动、心跳或普通回答伪造摘要。
- Responses 返回标准 `reasoning` item 和 `response.reasoning_summary_*` SSE 事件。
  当前为整轮完成时补发，不是实时推理流；不保证每次回答都有公开摘要。
- CF2 的 `gpt-5.6-reasoning` 和 `gpt-5.6-sol` 高档请求均已返回真实摘要。
  其他路由未取得同等实测证据，不把“支持思考档位”当成“已验收摘要”。
- 原版 Codex CLI 0.153.4 使用原模型配置实测主动发送 `reasoning.summary=auto`，
  收到 `item.completed / reasoning`，正常结束约 19.3 秒。固定本地模型目录缺少
  `default_reasoning_summary` 不是本次故障原因；不需要修改 API Key 或强制改客户端配置。
- 该次验收为原版 CLI 的 JSON 事件，不等于已经视觉检查用户正在使用的 TUI。
  证据：`reports/CF2-codex-summary-baseline-2026-09-06T03-39-43-024Z.json`。

当前图片状态（2026-09-06 13:47）：修复已重新进行，但真实识图仍未验收。候选改动统一了上传与ChatHub图片模式及可选fileUrl，完整441项测试通过；临时部署后三次原图实测仍无法读图，因此已恢复测试前代码。CF2当前版本为 `648483c0-aaad-4276-aeaf-467500cf6083`，产物与原 `91ce055d` 逐字节相同。**本地图片候选不能作为已修复版同步发布**，详见 `reports/CF2-image-reference-repair-20260906.md`。

内联图片先调用 Microsoft UploadFile，只有 Success、docId 与当前 conversationId 一致才继续 ChatHub；失败返回 image_upload_failed，不退回无图回答。远程图片 URL 当前明确返回 image_upload_inline_required，不代用户抓取未知 URL。API 路由和密钥不变，但不能据此宣称真实视觉能力已经通过。

服务端图片生成已经移除。OpenAI Images 的 generations、edits 和 variations 路径只返回
HTTP 501 / `image_generation_not_supported`，不会读取生成提示词、选择账号或访问微软。
这不改变上述图片输入与调用方本地图片工具的兼容路径。

本地开发只复制 `.dev.vars.example` 为 `.dev.vars`，并使用独立测试值。`.dev.vars` 已被忽略，禁止加入发布包。

变更 `wrangler.jsonc` 后执行：

```powershell
npm ci
npx wrangler types src/worker-configuration.d.ts
npm run check
```

生产配置必须始终显式传入 Account ID、Worker 名、Client ID 和原 KV ID，禁止依赖旧 `.wrangler` 缓存猜测账号。

CF2 的已验证授权配置根为 `C:\Users\exampleuser\AppData\Roaming\wrangler-cf2`，部署和回拉前必须设置 `XDG_CONFIG_HOME` 为该路径。默认 `xdg.config` 曾属于 CF3，不能混用。
