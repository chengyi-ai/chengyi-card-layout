# 共享账户启用说明

1. 创建一个 Supabase 项目。
2. 在 SQL Editor 中运行 `schema.sql`。
3. 在 Authentication → Users 中创建一位共享用户，邮箱和密码交给 ChengYi 与助理共同使用。
4. 打开项目 Settings → API，把 Project URL 与 Publishable key 填入根目录的 `cloud-config.js`。
5. 重新执行 `npm run build` 并部署 `dist`。

首次登录时，如果云端还没有数据，会先保留并自动上传当前浏览器中的业务数据；空云端不会覆盖本地。旧 `creator_workspace` 只迁移一次，迁移完成标记会阻止已经删除的数据再次复活。

当前版本对不同记录可以安全并行编辑；同一商单或同一排期仍采用最后保存者生效，请避免两个人同时修改同一条记录。
