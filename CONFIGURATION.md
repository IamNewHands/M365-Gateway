# 配置说明

本包不包含任何部署者的 Cloudflare 账号、域名、API Key、密码或登录缓存。

需要自行提供 Cloudflare Account ID、Worker 名称、Microsoft Entra 应用 Client ID；自定义域名和 R2 为可选项。wrangler.jsonc 内的全零示例 Client ID 不可用于真实授权。

绑定：TENANTS / TenantState、CHATS / ChatSession、INFERENCE / InferenceGateway，均为 SQLite Durable Object；SENSITIVE_KV 是加密凭据镜像；ASSETS 是管理页面。

Secret：DATA_ENCRYPTION_KEY、BOOTSTRAP_ADMIN_PASSWORD；可选 BOOTSTRAP_GATEWAY_API_KEY。只通过部署器或 Cloudflare Secret 设置。更新既有部署时必须保留原 KV 和加密密钥，不得把其他账号的存储或凭据复制过来。

M365 使用 ChatHub 协议，不是官方 OpenAI/Anthropic 服务。模型可用性取决于上游账号授权，不保证目录中的模型始终可调用。

推理请求经 Worker 原样转发至请求级 DO，JSON/上下文/工具协议/SSE 统计在 DO 内执行。此架构降低入口 CPU 压力，但不取消 DO 运行时长、调用次数、存储或 Microsoft 上游配额。

## 图片兼容范围

Responses 支持用户图片和 `function_call_output` / `custom_tool_call_output` 中的结构化 `input_image`。工具名称、call_id 和调用方参数不改变；图片不会被当作普通文字或直接嵌入持久化上下文。历史图片压缩后不保证可以再次查看，需要调用方重新提供原图。

图片上传必须取得 M365 的成功回执并匹配会话。此前真实上游上传曾返回 HTTP 403；本包的兼容回归使用模拟上游，不代表真实识图已验收。不得以本地测试通过、HTTP 200 或模型猜中答案代替真实图片读取验证。图片校验错误返回明确的多模态错误码，上传失败返回 `image_upload_failed`，不会静默降级为无图回答。

本包来自经过脱敏的可维护源码，不是从 Cloudflare 编译产物还原的 TypeScript，也不保证与现有线上发布逐字节一致。以 RELEASE.json 中的本地验证和未部署标记为准。
