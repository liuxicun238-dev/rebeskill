# Lingxi Model Gateway

这是灵犀内置模型的云服务器中转模板。

客户端调用链路：

```text
灵犀客户端 -> 你的云服务器网关 -> 模型厂商 API
```

客户端只保存你的网关地址和用户令牌，不保存厂商 API Key。

## 本地测试

```bash
cd services/lingxi-model-gateway
copy .env.example .env
npm start
```

Windows PowerShell 可临时设置环境变量：

```powershell
$env:MODEL_BASE_URL="https://api.openai.com/v1"
$env:MODEL_API_KEY="sk-..."
$env:MODEL_NAME="gpt-4o-mini"
$env:DEFAULT_FREE_QUOTA="200"
npm start
```

客户端设置里填写：

```text
网关地址：http://你的服务器:3000/v1
用户令牌：任意测试 token
首选模型：gpt-4o-mini
```

## 已实现接口

- `GET /v1/quota`：查询额度
- `POST /v1/chat/completions`：OpenAI Chat Completions 兼容流式转发

## 当前限制

第一版额度保存在内存里，重启会丢失。正式上线前应替换为数据库。

建议正式版补充：

- 账号系统：手机号、微信、邮箱或授权码
- 数据库：PostgreSQL/MySQL/SQLite
- 额度表：免费额度、付费额度、过期时间
- 限流：按 IP、设备、账号限流
- 日志：模型、token、耗时、错误码
- 支付：充值包、月卡或兑换码
- HTTPS 和反向代理
