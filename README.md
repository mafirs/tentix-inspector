# Tentix Inspector

面向 Tentix 插件场景的 Sealos/Kubernetes namespace 诊断服务。当前项目以 HTTP 服务形式运行，通过 `POST /api/skills` 接收工单上下文，以及 URL query 中的 `zone` 和 `namespace`。请求可以通过 `Authorization` header 携带请求级 kubeconfig；未提供时，服务会按 `zone` 使用本地 kubeconfig 拉取用户级 kubeconfig。随后由 LLM 在预置工具中选择最合适的查询动作，最终返回结构化 JSON 结果。

当前维护的主入口是 `src/server/http-server.ts`。仓库中保留了历史 `src/server/index.ts`（MCP/stdio 入口），但它已被 `tsconfig.json` 排除，不属于当前默认运行路径。

## 功能概览

- 单一 HTTP 入口：对外暴露 `POST /api/skills`
- 请求级 kubeconfig：可通过 `Authorization: Bearer <url-encoded-kubeconfig>` 传入 kubeconfig，服务会校验并仅在本次请求中使用
- 多区域访问：未传请求级 kubeconfig 时，根据 `zone` 选择本地 `kubeconfig`，再拉取用户级 kubeconfig 执行后续查询
- AI 路由：结合工单标题、描述、会话历史、最新消息和图片 URL 自动选择工具
- Namespace 强约束：
  - `zone` 和 `namespace` 只接受 URL query string
  - 请求体里的同名字段会被忽略
  - `namespace` 必须符合 `ns-...` 格式
  - 实际执行时会强制使用 query 中的 `namespace`，不信任模型返回值
- 故障兜底：
  - 路由失败时自动回退到 `list_pods_by_ns`
  - 当前输入不需要实时查询时返回 `204 No Content`
  - 超时错误会映射为 `504`

## 工作流程

1. HTTP 服务校验请求体，并从 query string 读取 `zone` 与 `namespace`
2. 如果请求带有 `Authorization` header，服务会 `decodeURIComponent()` 后用 Kubernetes SDK 校验 kubeconfig
3. 如果请求未带 kubeconfig，Agent 根据 `zone` 选择本地 kubeconfig，并读取 `users.user.sealos.io/v1` 的 `users/<username>` 资源
4. 从 `User.status.kubeConfig` 取出用户 kubeconfig
5. LLM 根据工单上下文选择工具，并生成工具输入
6. Executor 强制注入 query string 中的 `namespace`，执行对应 Kubernetes/Sealos 查询，返回统一结构的 JSON

其中 `<username>` 由 `namespace` 去掉前缀 `ns-` 后得到，例如 `ns-demo` 会映射为用户 `demo`。即使传入请求级 kubeconfig，`zone` 仍然是必填字段，并且必须属于当前支持的区域集合。

## 已注册工具

当前 HTTP Agent 在 `src/server/agent/graph.ts` 中注册了以下工具：

### 基础 Kubernetes 查询

- `list_pods_by_ns`：列出 Pod，适合作为默认首查入口
- `list_events_by_ns`：列出最近事件，适合排查调度、拉镜像、探针、挂载等失败
- `list_cronjobs_by_ns`：列出定时任务
- `list_ingress_by_ns`：列出域名与 Ingress 暴露配置
- `list_pvcs_by_ns`：列出 PVC 与持久化存储情况

### 应用与运行态查询

- `list_apps_by_ns`：聚合 Deployment 与 StatefulSet，适合应用配置排查
- `list_deployments_by_ns`：仅查询 Deployment
- `list_statefulsets_by_ns`：仅查询 StatefulSet
- `get_logs_by_ns`：自动解析最相关的 Pod/Container 并抓取日志，必要时返回候选项而不是直接失败

### Sealos 资源查询

- `list_devbox_by_ns`：查询 DevBox 资源
- `list_cluster_by_ns`：查询数据库集群资源
- `list_quota_by_ns`：查询资源配额
- `list_debt_by_ns`：查询欠费相关资源
- `list_objectstoragebucket_by_ns`：查询对象存储 Bucket 资源
- `list_certificate_by_ns`：查询证书资源

### 控制流

- `none`：当前轮输入不需要查询实时集群状态时返回；HTTP 层会把它转换为 `204 No Content`

## 环境要求

- Node.js 20 推荐；`package.json` 要求 `>= 18`
- 可访问目标 Kubernetes 集群的本地 kubeconfig，或请求中传入的有效 kubeconfig
- 一个兼容 OpenAI API 的模型服务

## 安装

```bash
npm ci
```

## 配置

### 1. 环境变量

创建或更新项目根目录下的 `.env`：

```bash
# 必填
AI_API_KEY=your_api_key
AI_BASE_URL=https://your-openai-compatible-endpoint

# 可选，默认 gemini-1.5-flash
AI_MODEL=gemini-1.5-flash

# 可选，默认 3000
PORT=3000

# 可选，默认 35000（毫秒）
LLM_TIMEOUT_MS=35000

# 可选，默认 60000（毫秒）
K8S_REQUEST_TIMEOUT_MS=60000

# 可选，工具描述覆盖文件路径（JSON）
TOOLS_DESC_OVERRIDE_FILE=./config/tools-override.json

# 可选，默认 codex；/api/codex-inspect 可选 codex 或 claude
AGENT=codex
```

说明：

- `AI_BASE_URL` 会在运行时自动补成以 `/v1` 结尾的地址
- `.env` 属于敏感配置，不应提交到版本库
- `TOOLS_DESC_OVERRIDE_FILE` 只覆盖各个工具的 description，不会覆盖 `SYSTEM_PROMPT` 本体
- 当前仓库已提供示例文件 `config/tools-override.json`
- 覆盖文件必须是 JSON 对象，key 必须是已注册工具名，value 必须是字符串

### 2. kubeconfig 文件

未通过请求传入 kubeconfig 时，项目按 `zone` 读取本地 kubeconfig 文件：

- `hzh` -> `kubeconfig/hzh-kubeconfig`
- `bja` -> `kubeconfig/bja-kubeconfig`
- `gzg` -> `kubeconfig/gzg-kubeconfig`
- `io` -> `kubeconfig/io-kubeconfig`

注意：

- `kubeconfig/` 目录中的内容属于敏感凭据，不应提交
- 如果你要使用某个 `zone` 且不传请求级 kubeconfig，必须提前准备对应文件
- 如果既没有请求级 kubeconfig，也没有对应本地文件，接口会返回 `404`

## 运行方式

### 开发模式

```bash
npm run dev:http
```

默认监听 `http://localhost:3000`。

### 生产模式

```bash
npm run build
npm run start:http
```

### Docker 镜像

项目根目录提供了 `Dockerfile` 与 `.dockerignore`，默认使用多阶段构建：

- 构建阶段安装完整依赖并执行 `npm run build`
- 运行阶段只保留生产依赖和 `dist/`
- `.env` 与 `kubeconfig/` 不会打入镜像，需要在运行容器时注入

构建镜像：

```bash
docker build -t tentix-inspector:local .
```

运行容器：

```bash
docker run --rm -p 3000:3000 \
  --env-file .env \
  -v "$PWD/kubeconfig:/app/kubeconfig:ro" \
  tentix-inspector:local
```

说明：

- 容器工作目录是 `/app`
- 代码会按 `/app/kubeconfig/<zone>-kubeconfig` 读取对应区域凭据
- `PORT` 默认是 `3000`，如需修改可通过环境变量覆盖
- 如果使用 `TOOLS_DESC_OVERRIDE_FILE`，请同时把对应文件挂载到容器内，并传入容器内路径，例如 `/app/config/tools-override.json`

### Tool 描述覆写文件

`TOOLS_DESC_OVERRIDE_FILE` 适合做不改代码的局部路由微调，尤其适合强化工具边界，例如：

- 把 `list_ingress_by_ns` 写得更偏向公网、域名、HTTPS、对外访问
- 把 `get_logs_by_ns` 写得更偏向启动失败、重启、CrashLoop、运行时异常
- 把 `list_quota_by_ns` 写得更偏向扩容、资源上限、配额不足
- 收紧 `none`，避免模型把仍在排障的工单过早归为不查询

示例格式：

```json
{
  "list_ingress_by_ns": "Prefer this as the FIRST tool when the main complaint is public access, custom domain, HTTPS, external IP, ingress, or port exposure.",
  "get_logs_by_ns": "Prefer this as the FIRST tool for startup failure, repeated restart, CrashLoop-like behavior, or runtime exceptions.",
  "none": "Return this tool only for pure greeting, thanks, acknowledgement, or clearly non-namespace product/account discussion."
}
```

注意：

- 未出现在文件中的工具会继续使用代码里的默认 description
- 覆盖文件路径支持相对路径和绝对路径
- 修改 override 文件后，需要重启服务进程让新描述生效

### 其他可用脚本

```bash
npm run watch
```

说明：

- `npm run dev` 等价于 `npm run dev:http`
- `npm run start` 等价于 `npm run start:http`
- `npm run dev:client` 和 `npm run start:client` 当前没有可用的 `src/client`，不要使用

## API 使用

### `POST /api/skills`

请求规则：

- `zone`：必填，放在 query string
- `namespace`：必填，放在 query string，且必须满足 `ns-...`
- 请求体可传工单上下文，但其中的 `zone` / `namespace` 不会生效
- `Authorization`：可选，推荐格式为 `Bearer <encodeURIComponent(kubeconfig)>`

请求级 kubeconfig 规则：

- kubeconfig 必须是 URL encoded 后的完整 kubeconfig 字符串
- 服务会用 `@kubernetes/client-node` 的 `loadFromString()` 校验内容
- 请求级 kubeconfig 优先级高于本地 `kubeconfig/<zone>-kubeconfig`
- 不支持从 JSON body 的 `kc`、`kubeconfig` 或同类字段读取 kubeconfig

请求体字段：

- `ticketTitle`
- `ticketModule`
- `ticketCategory`
- `ticketDescription`
- `historyMessages`
- `latestMessage`
- `latestMessageImages`

`latestMessageImages` 需要传图片 URL 数组。路由阶段最多会携带最近 6 个去重后的 URL；如果视觉路由失败，会自动回退到纯文本路由。

### 请求示例

```bash
curl -X POST 'http://localhost:3000/api/skills?zone=hzh&namespace=ns-example' \
  -H 'content-type: application/json' \
  -d '{
    "ticketTitle": "应用无法启动",
    "ticketModule": "applaunchpad",
    "ticketDescription": "用户反馈刚发布的新版本启动失败",
    "historyMessages": "之前尝试过重启，但问题仍然存在",
    "latestMessage": "帮我看一下容器日志和当前工作负载状态"
  }'
```

### 携带请求级 kubeconfig

```bash
KC_HEADER=$(node -e "process.stdout.write(encodeURIComponent(require('fs').readFileSync(process.argv[1], 'utf8')))" /path/to/kubeconfig)

curl -X POST 'http://localhost:3000/api/skills?zone=hzh&namespace=ns-example' \
  -H "authorization: Bearer ${KC_HEADER}" \
  -H 'content-type: application/json' \
  -d '{"latestMessage":"列出当前命名空间的 Pod"}'
```

### 成功响应示例

```json
{
  "tool": "list_pods_by_ns",
  "description": "...",
  "result": {
    "namespace": "ns-example",
    "pods": [
      {
        "name": "app-7d4f7c7f8f-rx2fk",
        "namespace": "ns-example",
        "status": "Running",
        "ip": "10.0.0.12",
        "node": "node-a"
      }
    ],
    "total": 1,
    "success": true
  }
}
```

### 响应语义

- `200`：成功返回某个工具结果
- `204`：Agent 认为当前轮不需要执行集群查询
- `400`：缺少 `zone` / `namespace`，或请求级 kubeconfig 编码、内容无效
- `404`：未传请求级 kubeconfig，且对应 `zone` 的本地 kubeconfig 文件不存在
- `500`：服务内部错误
- `502`：下游查询失败或 Agent 未能生成有效结果
- `504`：LLM 或 Kubernetes 请求超时

## 返回数据结构

HTTP 成功响应统一为：

```json
{
  "tool": "selected_tool_name",
  "description": "tool description",
  "result": {}
}
```

其中 `result` 会根据工具不同返回不同字段，但大多数工具都会包含：

- `namespace`
- 资源列表字段，例如 `pods`、`apps`、`events`、`pvcs`
- `total`
- `success`
- 失败时附带 `error`

`get_logs_by_ns` 额外会返回如下信息：

- `resolution`：`resolved`、`ambiguous_pod`、`ambiguous_container` 或 `no_match`
- `selectedPod`
- `selectedContainer`
- `logSource`：`current` 或 `previous`
- `logs`
- `podCandidates` / `containerCandidates`

## 开发说明

### 目录结构

```text
src/server/
├── http-server.ts         # HTTP 服务入口
├── agent/graph.ts         # Agent 初始化、LLM 路由、工具执行
├── kubernetes/            # Kubernetes 客户端封装与类型定义
└── tools/                 # 各类 Kubernetes / Sealos 查询工具
```

补充说明：

- `dist/`：TypeScript 编译产物
- `kubeconfig/`：本地集群凭据目录，敏感信息
- `src/server/index.ts`：历史 MCP 入口，默认不参与构建

### 本地验证

项目当前没有 root 单元测试、集成测试、lint 或 format 脚本。修改后至少执行：

```bash
npm run build
```

需要本地 smoke test 时，再启动服务并发送请求：

```bash
npm run dev:http

curl -X POST 'http://localhost:3000/api/skills?zone=hzh&namespace=ns-example' \
  -H 'content-type: application/json' \
  -d '{"latestMessage":"列出当前命名空间的 Pod"}'
```

`/api/codex-inspect` 需要请求级 kubeconfig，并按 `AGENT` 选择本地执行器。使用 `AGENT=claude` 时，运行环境还必须安装 `bubblewrap`，因为 Claude 会通过 `scripts/run-claude-inspect-sandbox` 进入外层进程沙箱：

```bash
AGENT=claude npm run dev:http

curl -X POST 'http://localhost:3000/api/codex-inspect?zone=hzh&namespace=ns-example' \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <url-encoded-kubeconfig>' \
  -d '{"latestMessage":"列出当前命名空间的 Pod"}'
```

端到端路由评估依赖 `.env`、有效 kubeconfig、集群网络访问，以及正在运行的本地服务：

```bash
# terminal 1
npm run dev:http

# terminal 2
npx ts-node evals/run_eval.ts
```

`evals/run_eval.ts` 会调用固定的本地接口地址并运行完整 `evals/evals.json` 数据集；没有 live credentials 或集群访问时不要运行。

## 常见问题

### 返回 `400 zone is required` 或 `400 namespace is required`

请确认两个参数写在 URL query string 中，而不是 JSON body 中。

### 返回 `Invalid namespace format, expected ns-xxx`

当前 Agent 只接受 `ns-...` 格式的 namespace，例如 `ns-demo`。

### 返回 `Unsupported zone`

请确认 `zone` 在当前代码支持的映射中。即使请求通过 `Authorization` 传入 kubeconfig，`zone` 仍会做支持区域校验；如果没有传请求级 kubeconfig，还需要确认对应本地 kubeconfig 文件已经准备好。

### 如何通过请求传入 KC？

把完整 kubeconfig 做 `encodeURIComponent()` 后放到 `Authorization` header 中，推荐格式是 `Bearer <encoded-kubeconfig>`。当前实现不会从 POST body 读取 KC。

### 路由结果不符合预期

当模型结构化输出失败时，服务会自动降级到 `list_pods_by_ns`。如果你希望调优路由，可通过 `TOOLS_DESC_OVERRIDE_FILE` 覆盖工具描述。

### 日志工具没有直接返回日志

`get_logs_by_ns` 会先尝试自动定位目标 Pod 与容器；如果候选项过多，它会返回 `ambiguous_pod` 或 `ambiguous_container`，让上游继续缩小范围。

## License

MIT
