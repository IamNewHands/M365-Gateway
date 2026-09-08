# Contributing

感谢改进 Cloudflare 原生版本。提交变更前请遵守以下约束：

1. 不得提交 OAuth token、API Key、Cookie、真实 KV ID、生产域名、账号邮箱、HAR、日志或 `.dev.vars`。
2. 不得把未真实验收的能力标记为可用；图片、音频、Realtime 等能力声明必须与模型目录和 README 一致。
3. 工具调用、会话续接、账号门控、密钥生命周期或持久化格式的修改必须附带回归测试。
4. 使用 Node.js 20 或更高版本，在提交前运行 `npm ci` 和 `npm run check`。
5. 可选 Relay 的 Go 代码变更还应在 `optional-egress-relay/` 中运行 `go test ./...`。

问题报告应包含最小复现、预期行为、实际状态码/错误码和已脱敏的环境信息。不要粘贴完整请求头、令牌或上游 URL 查询参数。
