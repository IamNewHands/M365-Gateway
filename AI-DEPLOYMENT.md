# AI 部署与维护说明

## 新部署

1. 阅读 README.md、CONFIGURATION.md、LICENSE-NOTICE.md。确认有权使用上游账号及发布源码。
2. 安装当前受支持的 Node.js，运行 `npm ci`。
3. 运行 `npm run check`，必须等待完整退出码 0，不以测试开始代替成功。
4. 运行 `npx wrangler login`，用户完成登录后执行 `npx wrangler whoami` 核对邮箱与 Account ID。多账号请为每个账号设置独立 XDG_CONFIG_HOME。
5. 执行部署器，替换占位参数：

```powershell
node deploy-cloudflare.mjs --yes --account-id YOUR_ACCOUNT_ID --name YOUR_WORKER --client-id YOUR_ENTRA_CLIENT_ID --domain api.example.com
```

部署器为新部署创建独立 KV 和加密 Secret。安全保存一次性管理员凭据，通过后台修改初始密码、添加自己授权的 M365 账号并创建客户端 API Key。不要把密钥写入聊天、Git、命令参数或报告。

## 更新部署

修改源码前检查当前版本和工作区，保留已有修改；补回归测试并执行完整 `npm run check`。使用：

```powershell
node deploy-cloudflare.mjs --update --yes --account-id YOUR_ACCOUNT_ID --name YOUR_WORKER --client-id YOUR_ENTRA_CLIENT_ID --kv-id YOUR_EXISTING_KV_ID --domain api.example.com
```

更新必须使用同账号原 KV、原加密密钥和原 DO 命名空间。v2 只新增 InferenceGateway，不删除旧 DO。回滚前检查 DO 迁移兼容性，不能用删除命名空间解决回滚报错。

## 验收

核对健康接口实际 Version 与部署回执一致；下载线上 Worker 后计算 SHA-256。串行验证模型发现、Responses 普通 SSE、原生工具调用及大工具结果续接、Chat Completions、Messages、取消后重试。客户端真实小任务也必须单独运行，不并发压测同一上游账号。

API 返回工具调用由客户端本地执行；Gateway 不能直接访问用户 Windows 文件系统。不得用托管下载链接、临时工作区或命令回显冒充本地成功。

只读日志与报告不得包含请求正文、工具结果、账号凭据。持续监测 CPU、内存、DO 用量和上游错误；短时健康或单次成功不等于数小时任务验收。
