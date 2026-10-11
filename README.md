<div align="center">

# TRSS-Yunzai DingTalk Plugin

TRSS-Yunzai 钉钉适配器插件

基于钉钉官方 Stream 模式，支持钉钉私聊 / 群聊消息收发与群管理

</div>

## 🐬 安装教程

需要先准备 [TRSS-Yunzai](../../../Yunzai)

<details>
  <summary>展开/收起</summary>

#### 🔧 Yunzai 根目录执行命令安装

```bash
git clone --depth=1 https://github.com/lylncode/DingTalk-Plugin.git ./plugins/DingTalk-Plugin
```

> [!NOTE]
> 如果你的网络环境较差，无法连接到 Github，可以使用代理加速下载服务
>
> ```bash
> git clone --depth=1 https://ghproxy.521002.xyz/https://github.com/lylncode/DingTalk-Plugin.git ./plugins/DingTalk-Plugin
> ```

#### 🔧 创建应用

1. 打开 [钉钉开发者后台](https://open.dingtalk.com) 创建企业内部应用，获取 `Client ID` 和 `Client Secret`
2. 应用内启用机器人能力，消息接收模式选择 **Stream 模式**，发布应用
3. 权限管理中申请「钉钉群基础信息管理权限」（群机器人资料回填、建群等群管理能力）

</details>

## 使用教程

- `#DingTalk账号` 查看已连接账号
- `#DingTalk设置ClientId:ClientSecret[:默认Webhook]` 添加或更新账号

配置文件 `config/DingTalk.yaml` 也可直接编辑，支持锅巴配置

## 消息支持

- 收：文本、@、图片、文件、语音、视频、富文本
- 发：纯文本、Markdown（`segment.markdown` 段）、按钮 ActionCard、互动卡片、图片 / 语音 / 视频 / 文件（接口方式，media_id 上传，本地 / 网页 / base64 / dataURL 源均可）
- 引用回复：纯文本「回复：」前缀展示

## 互动卡片

配置全局 `cardTemplateId` 后，正文与按钮合并为一张互动卡片投放（正文 Markdown + 任意行按钮）：

1. 在 [钉钉卡片平台](https://open-dev.dingtalk.com/fe/card) 导入插件附带的 [万能模板.json](万能模板.json) 并发布
2. 将发布后的模板 ID（`xxxx.schema`）填入 `config/DingTalk.yaml` 的 `cardTemplateId`，支持锅巴配置、热重载
3. 按钮规则：
   - 链接按钮：点击跳转 `actionURL`
   - `callback` / `input` 按钮：点击后内容作为消息触发插件指令处理，回复返回原会话
4. 按钮最多 5 行；按钮颜色按 `style` 自动映射：`0` 黑灰、`1` 蓝色线框、`2` 金色、`3` 红灰、`4` 实底蓝色，缺省蓝色线框
5. 卡片点击回调经 Stream 通道接收，无需配置回调地址

## 图片与图床

- 纯图片消息：走钉钉接口方式上传 media_id 发送，**无需图床**
- 图文混排 / Markdown 消息中的图片：钉钉要求公网 URL，发送时优先调用全局 `Bot.imageToUrl`（安装 [ImageBed-Plugin](https://gitee.com/wind-trace-typ/ImageBed-Plugin) 并配置图床即可），调用失败回退 `Bot.fileToUrl`（TRSS 文件服务地址，需钉钉客户端可访问）

## 群管理

- `Bot[id].createGroup({ name, owner, members })` 创建内部群，返回群 ID
- `group.setGroupName(name)` 修改群名（仅限本插件创建的群，钉钉 chatid 限制）
- `group.addMember(uid)` 拉人进群，支持单个或数组

## 配置说明

配置文件 `config/DingTalk.yaml`：

- `permission`：管理指令权限，默认 `master`
- `markdown`：全局 Markdown 开关，默认开启，开启后普通文本也按 Markdown 消息发送
- `cardTemplateId`：互动卡片模板 ID，配置后文本 / Markdown + 按钮消息走互动卡片投放，详见「互动卡片」
- `dingdingAccounts`：账号列表，`#DingTalk设置` 命令或锅巴添加，每账号支持：
  - `clientId` / `clientSecret`：应用凭证（必填）
  - `webhook`：默认 Webhook，主动发送（无 sessionWebhook）时的回退地址
  - `botName` / `botAvatar`：状态页展示的机器人名称 / 头像（群聊事件会自动回填真实资料）
  - `userInfo`：设为 `false` 关闭通讯录用户详情查询
  - `autoReconnect`：断线自动重连，默认开启
- `platformId` / `robotCode` / `chatIds` 等字段由适配器自动学习回写，无需手动填写

## 权限要求

钉钉开发者后台 → 应用 → 权限管理中申请：

| 能力 | 权限点 | 说明 |
| --- | --- | --- |
| 消息收发 | 机器人能力 | 启用机器人 + Stream 模式即可，无需额外权限点 |
| 接口方式发送消息（群聊 / 单聊 / 媒体） | 企业内机器人发送消息权限（`qyapi_robot_sendmsg`） | 图片 / 语音 / 视频 / 文件走接口方式时需要 |
| 媒体上传 | 调用企业 API 基础权限 | 默认具备 |
| 互动卡片投放 / 更新 | 互动卡片实例写权限（`Card.Instance.Write`） | 配置 `cardTemplateId` 使用互动卡片时需要，无需审批，未开通时卡片发送失败 |
| 用户昵称 / 头像补全 | 成员信息读权限（`qyapi_get_member`） | 未开通不影响消息处理，仅使用事件自带昵称 |
| 群机器人资料回填 / 建群 / 改群名 / 拉人 | 钉钉群基础信息管理权限（`qyapi_chat_manage`） | 未开通时群管理相关能力不可用 |

## 平台说明

- 平台 ID：钉钉回调的 `chatbotUserId` 为真实 Bot ID，适配器收到首条消息后自动学习保存，`self_id` 为 `dd_` 前缀 URL 编码形式；主人配置需使用该 ID
- 机器人名称 / 头像：群聊事件自动查询群机器人列表回填真实资料；私聊场景使用账号配置的 `botName` / `botAvatar`
- 用户昵称 / 头像：优先事件自带 `senderNick`，头像通过通讯录用户详情接口补全（需成员信息读权限，未开通不影响消息处理）
- 默认 Webhook：回复消息优先使用事件自带 `sessionWebhook`，主动发送（无 sessionWebhook）时回退账号配置的默认 Webhook

## 相关链接

- 许可证：MIT（[LICENSE](LICENSE)）
- TRSS-Yunzai：https://github.com/TimeRainStarSky/Yunzai
