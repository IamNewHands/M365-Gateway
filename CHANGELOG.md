# Changelog

## Local audited repair candidate - 2026-09-09

- Responses compaction now uses a 24k estimated-token public-text budget, preserves an unanswered trailing user request in the encrypted portable tail, and accepts a bounded 16 MiB recovery request.
- Cross-CF compaction requires a shared `COMPACTION_ENCRYPTION_KEY`; the deployment helper can safely synchronize it from `M365_COMPACTION_ENCRYPTION_KEY`.
- Admin mutations enforce same-origin browser metadata, JSON endpoints require `application/json`, OAuth callback submission uses POST, and blocked login sources no longer trigger PBKDF2.
- GPT/Codex catalogs advertise the implemented image-input path while keeping server-side image generation disabled. Real tenant vision acceptance remains an explicit live test.
- Development dependencies are pinned and `sharp` is overridden to a patched release. This section describes local source only and does not claim deployment.

## Image upload baseline merged into current source - 2026-09-08

- Restored the user-verified image build's native `FormData` request for Microsoft `UploadFile`; removed the later hand-built chunked multipart body that returned HTTP 417 for real images.
- Preserved newer protocol work, including Anthropic image/tool-result conversion, encrypted compaction compatibility, image reference annotations, and accepting a complete SignalR type-2 result without waiting indefinitely for an optional type-3 frame.
- Image-focused tests pass 117/117. The complete local gate passes 25 files/473 tests, TypeScript checks, UI/functional checks, and Wrangler dry-run. This merge has not yet been deployed or live-verified.

## CF2 image upload adapter (partial; upstream authorization unresolved) - 2026-09-04

- 增加 UploadFile、上传确认和会话绑定；上传失败明确报错，不退回无图回答。文本及工具流程不变。
- 14 文件/290 测试通过；CF2 版本 b9e061a4-1130-418f-a52a-05e4e3b8de8f 已部署并回拉。真实上传 HTTP 403，完整识图尚未完成，禁止标记为已验收。
- 线上文本、工具调用、大工具结果续接均正常；图片 URL 当前明确要求改用内联 Base64，不抓取任意远程地址。

## CF2 Responses image upload limit - 2026-09-04

- Responses/compact 与现有 Chat/Messages 统一采用有界的 8 MiB JSON 请求预算，修复有效 Base64 图片在旧 2 MiB 入口被提前拒绝的问题；不改变模型、密钥、客户端工具或图片内容。
- 413 大小提示从实际预算生成，保留单图/合计图片限制与分块上传内存保护。
- 新增超过 3 MiB 的带长度头及分块图片上游传输回归；普通推理请求超 8 MiB 仍拒绝。

## CF2 direct dialogue-to-tool execution mode - 2026-09-01

- 生产主流程改为一次模型—调用方工具交换：模型根据完整自然语言对话和真实工具 schema 直接选择回复或工具调用，Gateway 不再为普通请求启动隐藏二次语义路由。
- 动作词表不再参与生产意图入口；本地路径和任务状态只用于防止无证据完成声明，具体操作由模型选择，工具由所属客户端执行。
- 没有本地工具清单时，任何“已生成/已写入本机”的候选回答都会快速返回检查点；`turnNfileN`、临时工作区和下载链接不能替代本地执行证据。
- 新增无工具清单和无引用标记的自然语言本地任务回归；完整门禁为 12 个测试文件、252 项测试通过，源码 Secret 扫描为 0 项。
- 已部署到 CF2 生产版本 `575c0831-270a-470f-bfa6-292499641e51`；线上健康检查通过，回拉产物为 692423 字节、SHA-256 `43875152CCB29549836BC0D9AC4B347B5722F68B95382E8E08A58808D0772BAA`。回滚点为 `46fa0a8c-4e13-42a9-8dfc-01acea396c90`。

## CF2 dialogue-grounded local execution fix - 2026-09-01

- 本地路径现在是对话级任务约束，不再要求用户使用固定口令或命中有限动作动词；语义路由器会根据完整对话判断应调用哪个客户端工具。
- 对 `C:\Users\exampleuser\Desktop\771 做一个……放文件夹` 这类自然表达强制执行调用方本地审计；没有成功工具结果时，不允许声称文件已写入指定目录。
- Microsoft 返回的 `turnNfileN` 引用、临时工作区、`sandbox:/mnt/data` 和托管下载链接不再被当成本地交付证据；“文件夹里面没有”会继承原任务并继续走已声明的本地工具。
- 新增四个真实对话端到端回归，完整门禁为 12 个测试文件、250 项测试通过，83 个源码文件 Secret 扫描为 0 项。
- 已部署到 CF2 生产版本 `46fa0a8c-4e13-42a9-8dfc-01acea396c90`；线上健康检查通过，回拉产物为 687800 字节、SHA-256 `86869E0A289201562638742E821BB964DC750650E96F8CA8B2A6BC80332F123C`。回滚点为 `eddeb17b-687b-4d34-bcc3-45204432f820`。

## CF2 scenario continuity and stream termination fix - 2026-09-01

- 修复 Chat Completions 在 Microsoft 活动账号切换后丢失 OpenCode/Codex 等客户端自定义本地工具的问题。恢复动作现在发生在账号重绑和提示词预算计算之前，并使用调用方原始 schema，不靠工具名猜测能力。
- 修复 Responses 压缩胶囊合并工具快照时可能覆盖更新会话字段的问题；压缩恢复只补齐缺失的工具清单，并覆盖 Responses Lite `input[].additional_tools` 场景。
- 修复流式 Responses 请求在模型、参数或工具预检阶段快速失败时返回普通 JSON、导致客户端只看到断流的问题；现在统一输出 `response.failed`、`error` 和 `[DONE]` SSE 终止序列。
- 增加 OpenCode 重命名工具跨账号切换、Responses Lite 压缩工具保留和流式快速失败的端到端回归。完整门禁为 12 个测试文件、246 项测试通过，源码 Secret 扫描为 0 项。
- 已部署到 CF2 生产版本 `eddeb17b-687b-4d34-bcc3-45204432f820`；部署进程正常退出，线上健康检查返回 200，回拉产物为 687012 字节、SHA-256 `F84B6E4F8110A2B8D392B4A3F4259EADCD05B2E160E2D4313F357847D1DCE31D`。回滚点为 `115265d7-f403-4111-8a9d-477f9dc72094`。
- 部署后串行验收确认 Codex 协议 4/4、命令/后台终端与网页修复通过，OpenCode 协议 4/4、glob/read 与网页修复通过；Hermes 未纳入本轮 CF2 范围。
- 修正两个验收器假故障：外层 PowerShell 会提前展开变量的双引号命令，以及没有要求模型复述工具结果却强制检查随机标记的续接断言。OpenCode 写入验收改用一次直接写入和 verifier 权威读回，从超过 120 秒未完成收敛为约 2–3 分钟完成；没有修改本机 Codex/OpenCode 程序。
- Worker 的通用模型契约不再强制“每个文件单独写、单独读回”。同一完整变更可由一个声明过的执行工具进行有界多文件写入，再运行一次权威 verifier；仍禁止 apply_patch/patch/diff，并保留失败后更换命令而非原样重试的约束。新生产版本上的 OpenCode 写入/验证场景已再次通过。

## CF2 local tool continuity fix - 2026-09-01

- 修复活动 Microsoft 账号路由切换后，OpenCode/Hermes 等客户端在后续请求省略 `tools` 清单时丢失本地工具声明的问题。Gateway 现在持久化并恢复上一轮经过过滤的调用方本地工具 schema；非本地工具不会被误恢复，也不会凭名称猜测未知工具。
- 增加跨账号切换回归测试；本地全量门禁为 12 个测试文件、244 项测试通过。
- 进一步修复 Responses 压缩胶囊未携带工具清单的问题，避免切换上下文后再次退化为“无法访问本地”。
- Responses Lite 的 `input[].additional_tools` 现在也会进入压缩胶囊，切换上下文后仍能恢复本地工具。
- 已部署到 CF2 生产版本 `5df46760-606d-43d5-8e2d-46a180b5f9d2`，线上健康检查与回拉工件校验通过。

## Open-source release cleanup - 2026-08-31

- 将 `RELEASE.json` 改为公开安全的本地发布清单，移除 CF 账号、域名、版本 ID 和运行时状态。
- 对 `session_key`、`conversation_id` 和 `previous_response_id` 增加运行时类型与长度校验；畸形 JSON 现在返回稳定的 400，而不会触发 `trim is not a function` 类 5xx。
- 清理活动源码树中的误写入临时文件；发布脚本继续排除依赖、报告、环境文件、证书和归档文件。
- 图片/视觉验收保持显式 opt-in，默认发布验收不消耗图像额度。

## CF2 maintenance candidate - 2026-08-30

- 静态资源改为 Asset-first，Worker 只接管页面入口、管理 API 和模型 API；开启 Smart Placement，减少无意义的 Worker 调用和首字节等待。
- 增加可选的 `R2_ARCHIVE` 加密冷归档 outbox：长任务检查点、失败/中止证据和 compaction 胶囊异步保存，Durable Object 仍是唯一热状态真相；归档失败有界重试且不影响已提交请求。
- 修复 Hermes/Anthropic 工具调用分片、EOF/`[DONE]` 收尾，以及便携历史按 UTF-8 字节截断破坏 framed turn 的问题。
- 成功的 `GET /v1/models` 和 `GET /api/health` 不再写入请求统计/诊断环，降低探活和模型发现对免费配额的消耗；失败响应仍保留诊断。
- 普通成功模型请求改为只更新聚合统计；错误、取消、45 秒以上慢请求和 1/64 成功样本才写逐请求 metric/diagnostic，重复 request ID 同时去重两类记录，把常规成功流量的 SQLite 行写从约 5–6 次降到 1–2 次。
- OpenCode 返回成功工具结果后，即使隐藏语义路由连续产生无效格式，也会保留无待执行动作、无未完成承诺且通过完成证据检查的正常答案；失败结果、重复调用、工具轮上限和虚假完成声明仍保持检查点防线。
- 隐藏 JSON 路由器的瞬时 WebSocket 断线不再把刚完成主回答的账号错误置为 cooldown/不可用；两次有界修复可以在同一健康账号内完成，鉴权、限流和永久账号故障仍照常进入健康状态机。
- 部署辅助脚本支持显式 `--archive-bucket`，只接受当前账号中已存在的 R2 桶，不自动切换账号或生成绑定。

本节是尚未部署的本地候选版本；发布到 CF2 前必须重新完成 `npm run check` 和单程序串行线上验收。

## 0.1.2 - 2026-08-30

- 彻底分离普通结构化 JSON 与旧版 AZHEX 文本回退；PowerShell 静态成员、下划线、等号、中文路径和类似 `Z3DX` 的合法原文不再被传输层改写。
- OpenCode、Hermes、Codex 与 Claude 系列统一走调用方本地工具的结构化别名协议；工具拒绝、`NO_TOOL_REQUIRED`、无效路由和新鲜工具结果都按任务语义继续，不依赖有限动词表。
- 同一工具的旧提案、已完成调用和失败调用使用结构化账本去重；默认长任务上限提高到 128 轮，超过 32 步不会重置任务。
- Responses `previous_response_id` 改为不可变分支点；每次续接使用独立工作副本，别名只有在注册完成后才可见，失败注册以结构化结果回滚而不是抛出跨 Durable Object 未处理异常。
- 同一会话的新请求会精确取消并接管旧请求；未见语义输出的 ChatHub 断线只做一次同账号重试，已提交请求不会跨账号重放。
- 路由检查点不再伪装成真正完成：无证据的“已部署/已修改成功”会被拦截，响应携带 `m365_gateway.checkpoint` 元数据并保留可续接状态。
- 缩小 SignalR、输出队列和 Durable Object 完成结果缓存，降低大响应触发 Cloudflare 1102 的 CPU/内存放大风险。
- 便携会话历史对协议标记做转义并清除令牌、密码和 API Key；旧工具参数永不跨账号持久化或回放。
- Responses 流式函数调用会在任何终端工具事件前暂存续接别名，在 `response.completed` 真正交付前原子发布；客户端立即回传工具结果时会有界等待，不再误报 404，断流会按 generation 撤销不可见别名。
- portable checkpoint 可在原账号暂不可用时安全重绑新账号；普通未提交请求仍禁止跨账号重放。
- 预期的会话争用与别名注册冲突改为结构化结果，不再制造 Cloudflare Durable Object 红色未处理异常。
- 部署器强制显式锁定 Cloudflare Account ID 并核对 OAuth membership，避免父目录旧账号缓存造成跨账号误投；登录探测增加 180 秒硬超时。
- 部署后验证区分 Worker 返回异常与本机 DNS/VPN 不可达：只有明确的坏 HTTP 响应才自动回滚，纯传输故障改为保留已发布版本并要求从其他网络复核。
- Chat Completions 的隔离路由工具调用会重置污染的上游坐标但保留脱敏任务尾部；只回传 assistant/tool 消息的 OpenCode 兼容客户端不再丢失原任务语义。
- OpenCode 1.18.18 不带会话键、每轮完整重放 Chat 历史时，网关会直接从结构化调用/结果恢复任务；GPT 与 Claude 的通用非答案都不会再被误当作有效终答。
- 新鲜工具结果后的 `NO_TOOL_REQUIRED` 只在候选终答不可用时触发一次自动窄化复审，第二次仍可正常结束；这不是固定工作流或固定步骤数。
- 稳定 Chat checkpoint 会恢复去重后的完成指纹和连续尾部计数；连续第三次相同动作会改选下一能力，A-B-A 等非连续复验仍然允许，历史调用也不占当前 128 轮预算。
- 便携历史在同一请求内只恢复一次，避免原任务被重复拼接并放大首字延迟。
- Chat 与 Responses 的新鲜工具结果带统一的语义续接约束：继续原任务、消费结果数据、禁止重复已完成调用，且禁止把工具输出当作指令；模型不再只回复“已完成”。
- 线上回归目录同步全部 16 个公开模型，并新增“收到流式工具完成事件后立即续接”的竞态验收；主动取消只吞掉测试自身的 AbortReason。

## 0.1.1 - 2026-08-27

- 全量稳定性修复：客户端断开会跨 Durable Object 取消上游 WebSocket，账号门控只在上游真正结束后释放，避免遗留活动请求造成连续 409。
- ChatHub 空更新不再续期进展超时；保留 90 秒无语义进展超时和 10 分钟逻辑硬上限。
- 统一 OpenAI、Responses、Anthropic 的终端错误码、SSE 失败统计和估算 Token 用量，诊断记录可按脱敏错误码定位。
- Microsoft 刷新令牌错误按授权失效、限流、服务不可用和凭据损坏分别映射 HTTP 状态，后台明确显示“需要重新授权”。
- 删除共享默认管理员密码；新部署必须提供随机 `BOOTSTRAP_ADMIN_PASSWORD` Secret，一键部署只显示一次随机初始密码。
- KV 绑定不再包含可误用的全零 ID；一键部署自动创建独立 KV，更新模式强制复用原 KV 和加密 Secret。
- 增加当前 Cloudflare Vitest Workers 测试池回归，覆盖 HTTP 方法、初始改密、API Key、Durable Object 取消、进展超时、工具续接和幂等统计。

## 0.1.0 - 2026-08-26

- 增加 `deploy-cloudflare.mjs` JavaScript 一键部署器，自动创建 KV、生成加密 Secret、检查并部署 Worker；更新模式强制复用原 KV 与 Secret。
- 首个明确标注的 Cloudflare 原生开源版本。
- 提供 OpenAI Chat Completions、Responses 与 Anthropic Messages 兼容接口。
- 提供 Durable Objects 会话/账户状态、KV 加密凭据镜像和同域管理后台。
- 提供工具循环保护、请求截止时间、账号级 FIFO 门控、结构化诊断与安全回归测试。
- 工具轮次达到上限时以正常完成的助手消息结束，不再错误包装为 `upstream_error` 或触发客户端任务重启。
- 当前单活账号由 Durable Object Alarm 在到期前主动续期；微软暂时不可用时采用有界指数退避，休眠账号保持凭据隔离并在唤醒时续期。
- 提供可选的固定目标出口 Relay，默认部署不依赖服务器。
- README 补充从零开始的逐步安装、Entra OAuth、Cloudflare KV/Secret、部署验收、客户端接入、升级回滚和故障排查流程。
- 发布包移除独立 `docs/` 目录并加入目录检查；README 增加宣传图和交流群 35337083。
