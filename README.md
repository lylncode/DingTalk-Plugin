# DingTalk

这是一个独立的 TRSS-Yunzai 插件，结构参考 `Ding-plugin`，使用钉钉 Stream 模式接收消息，支持多账号、私聊、群聊、Markdown、图片链接和文件链接。

将本目录放入 `plugins/DingTalk-Plugin` 后重启。首次加载会生成根目录 `config/DingTalk.yaml`，填写其中的 `accountId`、`clientId`（AppKey）和 `clientSecret`（AppSecret），并在钉钉开发者后台订阅机器人 Stream 事件。

`webhook` 是主动发送消息时的回退地址；事件回复优先使用钉钉回调携带的 `sessionWebhook`。

DingTalk Bot 的平台账号 ID 统一使用 `dd_` 前缀。钉钉回调中的 `chatbotUserId` 才是真实的平台 Bot ID；由于 Yunzai 的主人配置使用冒号分隔 Bot ID 和用户 ID，适配器会对平台 ID 做 URL 编码。例如平台 ID 为 `$:LWCP_v1:$...` 时，`self_id` 为 `dd_%24%3ALWCP_v1%3A%24...`，原始值保存在 `bot.dingtalk_id`。适配器收到第一条回调后会按这个 ID 注册 `self_id`、`uin` 和 `Bot[id]`，并将它保存为账号的 `platformId`，后续重启直接使用同一个 ID。配置里的 `accountId` 只是本地账号标识，用于连接建立前识别账号，仍可填写自定义名称。

如果之前使用过未编码的 `dd_$:LWCP...` 设置过主人，请在适配器识别并保存新 ID 后重启一次，再重新执行 `#设置主人`，让主人配置写入新的 `dd_%24%3A...:用户ID` 格式。整个转换只在适配器内完成，不需要修改 TRSS-Yunzai 框架解析器。

### 椰奶状态中的名称和头像

椰奶状态读取的是 TRSS-Yunzai 中 DingTalk Bot 对象的 `nickname` 和 `avatar`。钉钉 Stream 消息事件不包含机器人头像，AppKey 也不是 QQ 号，因此无法使用 QQ 头像地址自动生成头像。适配器支持在每个账号上配置：

- `botName`：状态页展示名称；不填写时使用 `DingTalkBot (账号标识)`。
- `botAvatar`：状态页头像 URL。请填写 Yunzai 服务器能访问的图片地址；留空时椰奶状态使用默认头像。

可以在锅巴的 DingTalk 账号设置中填写这两个字段，保存后重启 Yunzai 生效。也可以直接编辑 `config/DingTalk.yaml` 对应账号项：

```yaml
dingdingAccounts:
  - accountId: DingDing
    botName: 我的钉钉机器人
    botAvatar: https://example.com/bot-avatar.png
    clientId: your-app-key
    clientSecret: your-app-secret
```

### 发送按钮

消息中的 TRSS `segment.button` 会转换为钉钉 ActionCard。当前支持带 `link` 的网页跳转按钮，每张卡片最多发送 5 个按钮：

```js
await e.reply([
  '请选择：',
  segment.button([
    [{ text: '打开文档', link: 'https://example.com/docs' }],
    [{ text: '访问主页', link: 'https://example.com' }],
  ]),
])
```

钉钉自定义机器人 webhook 的 ActionCard 按钮是链接跳转，不支持 TRSS 按钮的 `callback` 或 `input` 交互；这些按钮会被忽略。没有可用链接按钮时仍按普通 Markdown 消息发送。

### 图片与图床

DingTalk 发送图片时会先检查全局 `Bot.imageToUrl`：

1. 已安装并配置 `ImageBed-Plugin` 时，会自动使用它的图床优先级和上传配置，不需要额外修改 DingTalk。
2. 也可以自行写一个独立的单 JS 插件，在加载时设置 `Bot.imageToUrl`。下面示例可保存为 `plugins/My-ImageBed/index.js`。示例约定图床接收名为 `file` 的 multipart 字段，并返回 JSON `{ "url": "https://..." }`；请按实际图床 API 修改上传地址、鉴权方式、表单字段和返回值解析：

   ```js
   const uploadUrl = 'https://your-image-host.example/api/upload'
   const token = '在这里填写图床 Token'

   Bot.imageToUrl = async (file, opts = {}) => {
     const buffer = file?.buffer || file?.file || file
     if (!Buffer.isBuffer(buffer)) throw new TypeError('图床收到的图片不是 Buffer')

     const form = new FormData()
     form.append('file', new Blob([buffer]), opts.name || file?.name || 'image.png')
     const response = await fetch(uploadUrl, {
       method: 'POST',
       headers: { Authorization: `Bearer ${token}` },
       body: form,
     })
     const result = await response.json()
     if (!response.ok || typeof result.url !== 'string') {
       throw new Error(`图床上传失败 (${response.status}): ${JSON.stringify(result)}`)
     }
     return result.url
   }
   ```

   该插件不需要导出 `apps`，加载后设置全局 `Bot.imageToUrl` 即可。函数收到 TRSS 文件对象（通常含 `buffer` 和 `name`）以及可选参数 `{ name }`，必须返回钉钉可访问的公网图片 URL。请把 Token 放在本机私有配置中，不要提交到 Git。自定义图床和 `ImageBed-Plugin` 都会设置同一个全局接口，建议只启用其中一种，避免互相覆盖。
3. 如果没有 `Bot.imageToUrl`，或调用失败，DingTalk 会回退到 TRSS 的 `Bot.fileToUrl`。回退地址要求钉钉客户端能访问 TRSS 文件服务；文件消息仍使用 `Bot.fileToUrl`。

管理命令：

- `#DingTalk账号` 查看账号状态
- `#DingTalk设置账号标识:AppKey:AppSecret[:默认Webhook]` 添加或更新账号
- `#DingTalk重载` 保存当前配置
