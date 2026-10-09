# 更新日志

## 1.1.1 · 2026-10-10

### 新增

- 按钮消息：`segment.button` 段提取链接按钮转 ActionCard 发送（`btns` 数组格式，最多 5 个竖排按钮），兼容任意嵌套深度与被反引号包裹的 URL
- 引用回复：`segment.reply` 段以纯文本「回复：原内容」前缀展示，被引用内容取自消息缓存（上限 200 条）
- 语音 / 视频接收：单聊事件 `audio` / `video` 类型经 `messageFiles/download` 换取 CDN 地址，映射为 `audio` / `video` 段
- 群管理能力：`Bot[id].createGroup({ name, owner, members })` 创建内部群、`group.setGroupName(name)` 修改群名、`group.addMember(uid)` 拉人进群（需「钉钉群基础信息管理权限」；改群名仅限本插件创建的群，chatid 由创建群接口获取并持久化）
- 机器人基础信息完善：bot 注册补齐 `info` / `getFriendMap` / `getGroupMap` / `getMemberMap` / `pickUser` / `login` / `logout`（对齐 QQBot-Plugin）；群聊事件自动查询群机器人列表回填真实名称 / 头像
- 配置自动热重载：基于配置文件监听（chokidar），`config/DingTalk.yaml` 变更后自动对比账号配置，新增 / 变更的账号自动重连、删除的账号自动断开，无需重启或手动重载

### 优化

- 插件格式重构：移除 `lib` 配置包装层，直接使用核心 `makeConfig` 读取 `config/DingTalk.yaml`；适配器改为内联匿名类、压缩单行展开为标准缩进、方法名大写开头、配置项补中文注释（对齐 QBot-Plugin / DouYin-Plugin 范式）
- 设置命令：改为 `#DingTalk设置ClientId:ClientSecret[:默认Webhook]`，账号标识直接使用 Client ID，正则严格校验格式；移除 `#DingTalk重载` 命令
- 用户详情 / 群机器人列表缓存统一为「缓存池 + 失败负缓存」：过期自动清除，失败冷却 10 分钟后可自愈重试，不再永久跳过
- 日志格式：接收侧对齐 QQBot（`群消息：[群id, 用户id]` / `好友消息：[用户id]`）；日志中的 `self_id` 过长时截断显示（头 14 位 + … + 尾 5 位），不影响实际注册 ID
- 未配置账号时启动不再打印警告
- 版本号从插件自身 package.json 读取

### 文档

- README 按 DouYin-Plugin 结构重写：安装教程、使用教程、消息支持、图片与图床、群管理、配置说明、权限要求、平台说明
- 官方术语统一为 Client ID / Client Secret；锅巴字段同步

## 1.1.0 · 2026-10-10

### 新增

- 接口方式媒体发送：仅含图片 / 语音 / 视频 / 文件段的消息走钉钉官方接口发送（群 `groupMessages/send`，单聊 `oToMessages/batchSend`），媒体统一经 `media/upload` 上传换 media_id，本地 / 网页 / base64 / dataURL 源均可，无需图床公网地址；Webhook 侧仅保留文本 / Markdown / ActionCard
- Markdown 独立消息段：默认发纯文本，消息携带 `segment.markdown` 段时整条按 Markdown 发送（对齐 QQBot-Plugin 范式）
