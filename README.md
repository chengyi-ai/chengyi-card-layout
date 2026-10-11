# ChengYi 图文排版工具

纯本地、无登录的图文排版工具，拆自 `chengyi-creator-toolkit` commit `4b6c9cc`。没有账户系统、云端草稿或 API；编辑与图片、视频、Live Photo 导出均在浏览器中完成。运行依赖随站点提供，不使用公共 CDN。

## 本地开发与验证

```bash
npm run dev
# 或 npm start
npm test
npm run build
```

默认地址 `http://127.0.0.1:4173/`，可在 `.env` 配置 `HOST`、`PORT`。本地服务仅提供静态白名单文件，拒绝开发文件、路径穿越与符号链接；仅允许 GET、HEAD。

## 草稿与备份

草稿只保存在这台设备的浏览器里，请定期导出备份；换设备时用导入恢复。清除站点数据、更换浏览器或站点域名均不能自动带走草稿。

草稿正文使用 IndexedDB `chengyi-card-drafts-v2`，视频及封面使用 `chengyi-card-media-v1`，统一写入 `local` 分区。旧数据库保留原 keyPath `accountId` 以兼容历史数据，这个字段现在固定为 `local`，不表示登录账户。

首次读取会把本源下旧账户分区合并进本机分区。同草稿 ID 按 `updatedAt` 取较新版本；相同时间优先本机版本。删除记录取较新时间，删除时间不早于草稿更新时间时保留删除。素材按草稿 ID、媒体 ID、用途合并，同键取较新 `updatedAt`，相同时间优先本机。迁移标记随 IndexedDB 写入事务提交，旧分区不删除；后续打开不会重新迁移导致草稿复活。旧 localStorage 多草稿及单草稿也会迁移，原账户 key 保留；成功后标记，失败保留原数据供重试。IndexedDB 不可用时正文可回退 localStorage，视频存储仍需要 IndexedDB。

“导出备份”生成 JSON；含视频素材时生成包含 `manifest.json` 和素材的 ZIP。“导入备份”兼容旧版 1/2 JSON 与 3 ZIP，忽略备份的 `accountId`、`userId`、`ownerId` 字段，草稿与素材均落到本机分区。恢复作为独立副本加入，遇到 ID 重复会重命名，并同步更新视频引用。素材写入失败时回滚本次素材，不提交草稿。

从旧站（博主工具箱图文工具）迁移：**旧站导出备份 → 新站导入备份**。跨域不能直接读取旧站浏览器数据库；含视频务必使用 ZIP。

## 纯静态部署

构建校验第三方依赖 SHA-256，并输出纯静态 `dist/`，不生成 Worker，也不需要 R2 或认证环境变量。之后将 `dist/` 作为静态站点目录部署即可；本次改造不执行部署。

构建提供 `dist/_headers`，声明 nosniff、Referrer-Policy、X-Frame-Options、Permissions-Policy、CSP 和缓存策略。未验证 Sites 静态托管是否解析 `_headers`：如托管平台不支持，应在平台响应头设置中配置相同规则；静态文件本身无法保证 HTTP 安全头生效。本地开发服务继续返回这些安全头。

`manifest.json` 使用相对根路径。保留 `card-layout-reset.html` 和注销旧 Service Worker 的逻辑，清理旧 `card-tool-*` 缓存，不清理用户草稿。

## 开源许可证

项目代码采用 [MIT License](LICENSE)，允许使用、修改和商业使用，分发时需保留版权及许可证声明。

第三方依赖与改编代码继续遵守各自的许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [vendor/README.md](vendor/README.md)。
