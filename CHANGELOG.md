# 更新日志

## 1.1.5 · 2026-10-11

### 新增

- Bot API 补齐： `getFriendArray` / `getFriendList` / `getGroupArray` / `getGroupList` / `getGroupMemberMap` / `getGroupMemberArray` / `getGroupMemberList` / `getSystemMsg` / `getCookies` / `getCsrfToken` / `uploadImage` / `uploadVideo` / `uploadFile` 与好友 / 成员 / 群对象上的 `name` / `is_friend` / `is_owner` / `is_admin` / `card` / `getAvatarUrl` / `getMemberMap` 等字段方法；不支持的能力不再暴露（移除占位方法，避免返回 reject 导致第三方插件等待挂起）
- 用户与群信息查询：`bot.getUserInfo(userIds)` 批量查询通讯录用户详情、`bot.getChatInfo(groupId)` 查询自建群群名 / 群主 / 成员列表；`pickFriend.getInfo()` 真查详情补全昵称头像，`pickGroup.getInfo()` 自建群拉取真实信息并填充成员缓存
- 消息撤回：`recallMsg` 真实实现——接口方式发送的普通消息记录 `processQueryKey` 并与真实 `message_id` 绑定（24h），撤回走群聊 `groupMessages/recall` / 单聊 `otoMessages/batchRecall` 官方接口；发送链路各分支返回真实 message_id（多条媒体返回数组）
- 纯文本卡片化开关 `cardText`：默认关闭时纯文本 / Markdown 走普通消息接口（可撤回），开启时也合并为互动卡片投放（钉钉互动卡片不支持撤回）
- 语音音质提升：非 ogg / amr 语音经 ffmpeg 转码为 ogg / opus（32kbps 全频带），替代原 8kHz amr 窄带转码，音质明显提升；原生 ogg / amr 直接发送，转码失败仍降级为文件附件
- 全局 Markdown 下音乐等媒体段独立走接口发送：`music` / `audio` / `record` / `video` / `file` 段从 Markdown 渲染中摘出，按原本接口方式发送，剩余文本 + 图片继续 Markdown 渲染
- 机器人资料完善：机器人头像 / 昵称支持——群聊事件回填真实资料，带签名的临时头像链接自动转存为稳定地址（启动与群聊事件时），bot 复用时同步配置昵称 / 头像
- 消息发送完全移除 Webhook 依赖：文本 / Markdown / 媒体 / 按钮 / 卡片全部走机器人消息接口（群聊 `groupMessages/send`，单聊 `oToMessages/batchSend`），移除设置命令 Webhook 参数、锅巴 Webhook 配置项

### 修复

- 卡片回调群 / 单聊判定加强：场域映射改双 key（outTrackId + spaceId）并延长 TTL 至 7 天，回调时优先查映射，未命中按钉钉场域特征兜底（openConversationId 固定 `cid` 前缀），不再因缓存过期误判私聊
- 撤回未命中记录时不再抛错：`recallMsg` 对互动卡片 / 非接口消息静默返回 `false` + debug 日志，避免插件定时调用产生 unhandled rejection
- 语音播放卡顿 / 无法播放：全局 Markdown 模式下音乐等媒体段被吞的问题
- `#椰奶状态pro` 卡住：bot `avatar` 空串时状态插件对空 URL 发请求挂起，默认改为 `"default"` 占位；补 `status` 与 `sent_msg_cnt` / `recv_msg_cnt` 统计，对齐 Yunzai 标准 bot 字段
- oicq `segment.button` 二维数组多包一层导致按钮解析为 0 行的问题

### 优化

- 空正文按钮消息不再发送（避免 `+1` 等插件附加按钮产生的空白卡片）
- 按钮点击恢复原会话：修复 rollpig 等插件点击回调因缓存过期误发私聊

## 1.1.4 · 2026-10-11

### 新增

- 互动卡片按钮颜色：按 Yunzai 按钮 `style` 自动映射钉钉卡片颜色（0 黑灰 / 1 蓝色线框 / 2 金色 / 3 红灰 / 4 实底蓝，缺省蓝色线框），颜色取值经卡片平台实测为 `gray` / `blue` / `gold` / `red` / `blue_filled`

### 修复

- 互动卡片按钮解析为 0 行的问题：oicq `segment.button` 为 rest 参数，二维按钮数组会多包一层，解析时逐层剥开直到真正的行数组，兼容一维 / 二维 / 单按钮三种形态

## 1.1.3 · 2026-10-11

### 新增

- 互动卡片：全局 `cardTemplateId` 配置后文本 / Markdown 与按钮合并为一张互动卡片投放（万能模板：Markdown 正文 + 最多 5 行按钮组，行结构对齐 Yunzai 按钮段二维数组），卡片外显摘要自动从正文提取
- 互动卡片按钮回调：`callback` / `input` 按钮点击经 Stream 回调接收，内容模拟为点击者的消息事件触发插件指令处理，回复返回原会话；群 / 单聊场域按发送时记录的映射判断，不依赖群列表时序
- 全局 Markdown 开关：`markdown: true`（默认）开启后普通文本也按 Markdown 消息发送，关闭发纯文本；显式携带 `segment.markdown` 段时始终按 Markdown 发送，支持热重载
- ActionCard 按钮增强：按数量自动匹配 `sampleActionCard` ~ `sampleActionCard5`（字段名严格对应官方要求），支持链接与 `callback` / `input` 按钮混合，超过 5 个截取前 5 个并警告
- 语音转码链路：原生 amr 直接发送；silk 经 silk-wasm 解码后转 amr；其他格式经 ffmpeg 转 amr；转码失败统一降级为文件附件
- 音乐分享：`segment.music` 段以 `sampleLink` 链接消息发送（标题 / 简介 / 封面 / 跳转地址）
- 视频参数补全：ffprobe 自动探测时长（秒）/ 宽 / 高，无封面源时 ffmpeg 抽取首帧作为封面；媒体发送前统一获取真实文件 Buffer，规避 `http: true` 返回 URL 字符串导致探测失败
- 锅巴配置：新增 `markdown` / `cardTemplateId` 字段，保存时正确回显避免空值覆盖

### 修复

- 卡片回调事件预置 `isGroup` / `isPrivate`，避免 loader 冷却检查将事件误判为群消息静默拦截
- 回调触发的模拟消息无 `sessionWebhook` 时：卡片走卡片接口、正文走机器人消息接口，不再报「消息缺少 sessionWebhook」

### 优化

- 图片 URL 统一接入 ImageBed-Plugin 的 `Bot.imageToUrl`（图床优先，失败回退 `Bot.fileToUrl`）
- 卡片回调日志降为 debug 级别
- README 增补互动卡片配置说明、卡片平台地址与权限要求

## 1.1.1 · 2026-10-10

### 新增

- 混合消息分段发送：图文混排等混合消息按段顺序拆组，连续媒体段走接口方式发原生媒体，其余段合并走 Webhook，按原顺序依次发送（携带 markdown 段时保持整条一条，图片内嵌公网 URL）
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
