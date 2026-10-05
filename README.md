# ChengYi 图文排版工具

独立项目，拆自 `chengyi-creator-toolkit` commit `4b6c9cc`。本仓库只保留图文排版工具、云端草稿同步接口与对应测试；没有复制原工具箱的 `.openai/hosting.json`，上线前需要新建独立的 OpenAI/Sites 项目。

## 本地开发

```bash
npm run dev
# 或
npm start
```

默认监听 `http://127.0.0.1:4173/`。本地静态服务只允许图文工具运行所需的白名单文件；`.env`、`tests/`、`server.mjs` 等私有或开发文件不会被暴露。

## 测试

```bash
npm test
```

只运行从源仓库带出的 `tests/card-*.test.mjs` 图文工具相关测试。

## 构建

```bash
npm run build
```

构建会：

1. 校验本地 vendored 第三方依赖的 SHA-256；
2. 生成 `dist/` 静态文件；
3. 生成 `dist/server/index.js` Sites Worker；
4. 复制 `worker/card-draft-handler.mjs` 到 `dist/server/card-draft-handler.mjs`。

`dist/server/index.js` 只包含图文工具静态资源和 `/api/card-drafts` 路由，不包含原工具箱其它业务接口。

## 环境变量与绑定

前端登录配置在 `cloud-config.js`：

- `supabaseUrl`
- `supabasePublishableKey`

本地服务和 Sites Worker 草稿接口使用：

- `SUPABASE_URL`：Supabase Project URL；未设置时沿用源工具箱项目默认值。
- `SUPABASE_PUBLISHABLE_KEY`：Supabase publishable key；未设置时沿用源工具箱项目默认值。
- `PUBLIC_ORIGIN`：本地把 Node 请求适配为 Fetch Request 时可选的源站地址。
- `PORT` / `HOST`：本地开发服务端口与监听地址。
- `CARD_DRAFTS`：Cloudflare R2 绑定名，用于 `/api/card-drafts` 存储用户草稿。

这个独立项目与原工具箱共用同一个 Supabase 项目登录；`/api/card-drafts` 会通过 Supabase `/auth/v1/user` 校验 Bearer token 后，按用户 ID 哈希写入 R2 `card-drafts/<sha256>.json`。

## 部署提示

不要复用原工具箱的 Sites project_id。本仓库刻意不创建 `.openai/hosting.json`；首次部署前请为图文排版工具新建 Sites 项目，并配置 R2 绑定 `CARD_DRAFTS`。

## 路径调整

源仓库中 `tools/card-layout/` 的内容已提升到项目根目录，因此：

- `/tools/card-layout/index.html` → `/index.html`
- `../../cloud-config.js` → `cloud-config.js`
- `../../vendor/supabase.js` → `vendor/supabase.js`
- `tools/card-layout/vendor/*` → `vendor/*`
- Service Worker / reset 页清理范围从旧 `/tools/card-layout/` 调整为当前独立站点 origin。
- `manifest.json` 保持根路径相对 scope：`start_url: "./index.html"`、`scope: "./"`。

## 关于 `card-layout-reset.html`

仍保留。它用于清理源工具箱旧版图文工具遗留的缓存优先 Service Worker 和 `card-tool-*` Cache Storage，然后跳回根路径 `index.html`。该页面不会清理用户草稿。
