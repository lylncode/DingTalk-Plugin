logger.info(logger.yellow("- 正在加载 DingTalk 适配器插件"))

import { readFileSync } from "fs"
import { readFile, writeFile, rm } from "fs/promises"
import { randomUUID } from "node:crypto"
import { spawn } from "child_process"
import { tmpdir } from "os"
import path from "path"
import { WebSocket } from "ws"
import makeConfig from "../../lib/plugins/config.js"
import chokidar from "chokidar"
import _ from "lodash"

// 插件版本号从 package.json 读取
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)))

const { config, configSave, configFile } = await makeConfig(
  "DingTalk",
  {
    tips: "",
    permission: "master",
    // 全局 Markdown 开关：开启后普通文本消息也按 Markdown 消息发送，关闭则发纯文本（Markdown 段始终按 Markdown 发送）
    markdown: true,
    // 互动卡片模板 ID：配置后文本/Markdown 消息走互动卡片投放（万能模板：md 正文 + 任意数量按钮 + Stream 回调）
    cardTemplateId: "",
    // 媒体上传策略（保留字段，图片经图床/本地转 URL 发送）
    uploadStrategy: "public-url",
    dingdingAccounts: [],
  },
  {
    tips: [
      "欢迎使用 TRSS-Yunzai DingTalk Plugin !",
    ],
  },
  // 监听配置文件变化，实现配置热重载
  { watch: true },
)

const adapter = new (class DingTalkAdapter {
  constructor() {
    this.id = "DingDing"
    this.name = "DingTalk"
    this.version = version
    this.path = this.name
    // 已管理账号：accountId -> { config, bot, socket, timer }
    this.managedAccounts = new Map()
    // 缓存池（key -> { value, expires }）：用户详情 / 群机器人列表，各缓存一天
    this.userInfoCache = new Map()
    this.groupRobotCache = new Map()
    // 失败冷却（负缓存，同样带过期）：冷却期内不重试也不重复告警，避免权限缺失时刷屏
    this.userInfoErrors = new Map()
    this.groupRobotErrors = new Map()
    // 收到的消息内容缓存（msgId -> 文本，上限 200 条）：供 reply 段渲染引用
    this.messageCache = new Map()
    // 互动卡片场域映射（outTrackId -> { group_id, user_id }）：卡片回调据此刻别群/单聊，避免依赖 gl 时序
    this.cardSpaces = new Map()
  }

  // bot self_id：钉钉 platformId（chatbotUserId）学习后写回配置，未学习前用账号标识
  platformKey(platformId) {
    return `dd_${encodeURIComponent(String(platformId || "default"))}`
  }

  // 日志展示用 id：钉钉 platformId 编码后过长，截取头尾
  logId(id) {
    const key = String(id || "")
    return key.length > 20 ? `${key.slice(0, 14)}…${key.slice(-5)}` : key
  }

  log(level, accountId, ...args) {
    Bot.makeLog(level, args.map(value => Bot.String(value)).join(" "), accountId ? this.logId(accountId) : this.name, true)
  }

  // 缓存读取：过期即清除并返回 null
  getCache(map, key) {
    const cached = map.get(key)
    if (!cached) return null
    if (cached.expires <= Date.now()) {
      map.delete(key)
      return null
    }
    return cached.value
  }

  // 缓存写入：默认一天，负缓存传短 ttl
  setCache(map, key, value, ttl = 86400000) {
    map.set(key, { value, expires: Date.now() + ttl })
  }

  // 缓存收到的消息内容，供 reply 段渲染引用；超上限淘汰最早一条
  cacheMessage(id, value) {
    if (!id || !value) return
    this.messageCache.set(String(id), value)
    if (this.messageCache.size > 200)
      this.messageCache.delete(this.messageCache.keys().next().value)
  }

  load() {
    const accounts = Array.isArray(config.dingdingAccounts) ? config.dingdingAccounts : []
    if (!accounts.length) return
    for (const account of accounts)
      this.startAccount(account).catch(error => this.log("error", account.accountId, "账号启动失败", error))
  }

  // 打开 Stream 长连接：网关下发 endpoint + ticket，凭 ticket 建立 WebSocket
  async openStream(account) {
    const response = await fetch("https://api.dingtalk.com/v1.0/gateway/connections/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: account.clientId,
        clientSecret: account.clientSecret,
        subscriptions: [
          { type: "CALLBACK", topic: "/v1.0/im/bot/messages/get" },
          // 互动卡片按钮回调（callbackType=STREAM 时经此 topic 推送）
          { type: "CALLBACK", topic: "/v1.0/card/instances/callback" },
        ],
      }),
    })
    const data = await response.json()
    if (!response.ok || !data.endpoint || !data.ticket)
      throw new Error(`打开 DingTalk Stream 失败: ${Bot.String(data)}`)
    return new WebSocket(`${data.endpoint}?ticket=${encodeURIComponent(data.ticket)}`)
  }

  // 获取 access token：过期前 5 分钟定时刷新
  async getAccessToken(account) {
    const response = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appKey: account.clientId, appSecret: account.clientSecret }),
    })
    const data = await response.json()
    if (!response.ok || !data.accessToken)
      throw new Error(`获取 DingTalk access token 失败: ${Bot.String(data)}`)
    account.accessToken = data.accessToken
    clearTimeout(account.tokenTimer)
    const tokenTimer = setTimeout(
      () => this.getAccessToken(account).catch(error => this.log("error", account.accountId, error)),
      Math.max(60000, (Number(data.expireIn || 7200) - 300) * 1000),
    )
    // 运行期定时器句柄不可序列化进 DingTalk.yaml，用 defineProperty 挂非枚举属性
    Object.defineProperty(account, "tokenTimer", { value: tokenTimer, writable: true, configurable: true })
    return data.accessToken
  }

  // 消息文件下载码 → CDN 下载地址（图片/文件事件携带 downloadCode）
  async downloadFile(account, downloadCode) {
    if (!downloadCode) return ""
    const response = await fetch("https://api.dingtalk.com/v1.0/robot/messageFiles/download", {
      method: "POST",
      headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": account.accessToken },
      body: JSON.stringify({ downloadCode, robotCode: account.clientId }),
    })
    const data = await response.json()
    if (!response.ok || !data.downloadUrl)
      throw new Error(`下载 DingTalk 文件失败: ${Bot.String(data)}`)
    return data.downloadUrl
  }

  // 用户详情（昵称/头像），按 账号:userid 缓存一天；account.userInfo 为 false 时关闭查询
  async getUserInfo(account, userId) {
    if (!userId || account.userInfo === false) return {}
    const accountId = String(account.accountId || account.clientId || "default")
    const key = `${accountId}:${userId}`
    const cached = this.getCache(this.userInfoCache, key)
    if (cached) return cached
    const response = await fetch("https://oapi.dingtalk.com/topapi/v2/user/get", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
      body: new URLSearchParams({ access_token: account.accessToken, language: "zh_CN", userid: String(userId) }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || (data.errcode && Number(data.errcode) !== 0))
      throw new Error(`获取 DingTalk 用户详情失败: ${Bot.String(data)}`)
    this.setCache(this.userInfoCache, key, data.result || {})
    return data.result || {}
  }

  // 群机器人列表（用于回填机器人真实名称/头像），按 账号:群id 缓存一天
  async getGroupRobots(account, groupId) {
    if (!groupId) return []
    const accountId = String(account.accountId || account.clientId || "default")
    const key = `${accountId}:${groupId}`
    const cached = this.getCache(this.groupRobotCache, key)
    if (cached) return cached
    const response = await fetch("https://api.dingtalk.com/v1.0/robot/groups/robots/query", {
      method: "POST",
      headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": account.accessToken },
      body: JSON.stringify({ openConversationId: String(groupId) }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`获取 DingTalk 群机器人列表失败: ${Bot.String(data)}`)
    const value = Array.isArray(data.chatbotInstanceVOList) ? data.chatbotInstanceVOList : []
    this.setCache(this.groupRobotCache, key, value)
    return value
  }

  // bot 所属账号配置（群管理接口需要 accessToken，不在 bot 上暴露完整配置）
  configFor(bot) {
    return [...this.managedAccounts.values()].find(item => item.bot === bot)?.config
  }

  // 创建内部群：POST /v1.0/im/group/create，需「钉钉群基础信息管理权限」
  // name 1~20 字；owner/members 均为 userId（Yunzai 侧即 user_id/staffId），owner 必须在应用可见范围内
  // 返回 openConversationId（即 Yunzai group_id），同时保存 chatid 映射（改群名等 update 接口仅认 chatid）
  async createGroup(config, { name, owner, members = [] }) {
    const response = await fetch("https://api.dingtalk.com/v1.0/im/group/create", {
      method: "POST",
      headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": config.accessToken },
      body: JSON.stringify({ name, owner, useridlist: members, conversationTag: 2 }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(`创建 DingTalk 群失败: ${Bot.String(data)}`)
    if (data.openConversationId && data.chatid) {
      config.chatIds = { ...(config.chatIds || {}), [String(data.openConversationId)]: String(data.chatid) }
      configSave()
    }
    return data.openConversationId
  }

  // 修改群名：POST /v1.0/im/group/update，仅支持本插件创建的群（chatid 只有创建群接口会返回）
  async setGroupName(config, group_id, name) {
    const chatid = config.chatIds?.[String(group_id)]
    if (!chatid) throw new Error("该群非本插件创建，无法获取 chatid，钉钉不支持修改群名")
    const response = await fetch("https://api.dingtalk.com/v1.0/im/group/update", {
      method: "POST",
      headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": config.accessToken },
      body: JSON.stringify({ chatid, name }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`修改 DingTalk 群名失败: ${Bot.String(data)}`)
    return true
  }

  // 拉人进群：POST /v1.0/im/sceneGroup/member/add，user_ids 为 userId 列表
  async addGroupMember(config, group_id, user_id) {
    const response = await fetch("https://api.dingtalk.com/v1.0/im/sceneGroup/member/add", {
      method: "POST",
      headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": config.accessToken },
      body: JSON.stringify({ open_conversation_id: String(group_id), user_ids: [...[user_id].flat().map(String)] }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || data.success === false)
      throw new Error(`DingTalk 拉人进群失败: ${Bot.String(data)}`)
    return true
  }

  // 群聊事件时回填机器人真实名称/头像（优先 robotCode 匹配，唯一机器人时直接采用），并记住最近会话 id
  async updateBotProfile(entry, body) {
    if (String(body.conversationType) !== "2" || !body.conversationId) return
    const groupId = String(body.conversationId)
    if (entry.config.lastConversationId !== groupId) {
      entry.config.lastConversationId = groupId
      configSave()
    }
    let robots
    try {
      robots = await this.getGroupRobots(entry.config, groupId)
    } catch (error) {
      const errorKey = `${entry.config.accountId || entry.config.clientId}:${groupId}`
      if (!this.getCache(this.groupRobotErrors, errorKey)) {
        this.setCache(this.groupRobotErrors, errorKey, true, 600000)
        this.log("warn", entry.bot.self_id, "获取群内机器人资料失败，已使用配置名称/头像", error)
      }
      return
    }
    const codes = new Set(
      [body.robotCode, entry.config.robotCode, entry.config.clientId].filter(Boolean).map(String),
    )
    const profile = robots.find(item => codes.has(String(item.robotCode))) || (robots.length === 1 ? robots[0] : null)
    if (!profile) return
    let changed = false
    if (profile.name && (!entry.config.botName || entry.config.botName === entry.bot.nickname)) {
      entry.config.botName = String(profile.name)
      entry.bot.nickname = String(profile.name)
      changed = true
    }
    if (profile.downloadIconURL && (!entry.config.botAvatar || entry.config.botAvatar === entry.bot.avatar)) {
      entry.config.botAvatar = String(profile.downloadIconURL)
      entry.bot.avatar = String(profile.downloadIconURL)
      changed = true
    }
    if (changed) configSave()
  }

  // 启动单个账号：获取 access token → 打开 Stream 连接 → 注册事件监听
  async startAccount(account) {
    const accountId = String(account.accountId || account.clientId || "default")
    if (!account.clientId || !account.clientSecret)
      return this.log("error", accountId, "缺少 clientId 或 clientSecret")
    // platformId 由钉钉首个回调学习后写回配置，重启沿用
    const bot = this.makeBot(this.platformKey(account.platformId || accountId), account)
    let socket
    try {
      await this.getAccessToken(account)
      socket = await this.openStream(account)
    } catch (error) {
      this.log("error", accountId, error)
      if (account.autoReconnect !== false) this.scheduleReconnect(account)
      return
    }
    const entry = { config: account, bot, socket }
    this.managedAccounts.set(accountId, entry)
    if (account.lastConversationId)
      this.updateBotProfile(entry, {
        conversationType: "2",
        conversationId: account.lastConversationId,
        robotCode: account.robotCode,
      }).catch(() => {})
    socket.on("open", () => {
      this.log("mark", bot.self_id, `钉钉机器人 ${bot.self_id} 已连接`)
      Bot.em(`connect.${bot.self_id}`, { self_id: bot.self_id, bot })
    })
    socket.on("message", data => this.handleStreamMessage(entry, data))
    socket.on("error", error => this.log("error", bot.self_id, "Stream 错误", error))
    socket.on("close", () => {
      // 已被重连接管（socket 已更换）时不再处理
      const current = this.managedAccounts.get(accountId)
      if (current?.socket !== socket) return
      this.managedAccounts.delete(accountId)
      this.log("warn", bot.self_id, "Stream 已断开")
      if (account.autoReconnect !== false) this.scheduleReconnect(account)
    })
  }

  // 断开账号连接并清理定时器（保留配置）
  async stopAccount(accountId) {
    const entry = this.managedAccounts.get(String(accountId))
    if (!entry) return false
    this.managedAccounts.delete(String(accountId))
    clearTimeout(entry.config?.tokenTimer)
    clearTimeout(entry.timer)
    entry.socket?.close()
    return true
  }

  // 断线重连：按账号去重，同一账号仅一个等待中的定时器
  scheduleReconnect(account) {
    const accountId = String(account.accountId || account.clientId || "default")
    if (this.managedAccounts.get(accountId)?.timer) return
    const timer = setTimeout(() => {
      const entry = this.managedAccounts.get(accountId)
      if (entry) delete entry.timer
      this.startAccount(account).catch(error => this.log("error", accountId, error))
    }, Math.max(1000, Number(account.reconnectInterval || 10) * 1000))
    const old = this.managedAccounts.get(accountId) || {}
    this.managedAccounts.set(accountId, { ...old, config: account, timer })
  }

  // 创建/复用 bot 实例：同适配器同 id 直接复用
  makeBot(self_id, account) {
    const old = Bot[self_id] || Bot.bots[self_id]
    if (old?.adapter === this) return old
    const bot = {
      adapter: this,
      self_id,
      uin: self_id,
      dingtalk_id: account.platformId,
      nickname: account.botName || `DingTalkBot (${account.accountId})`,
      avatar: account.botAvatar || "",
      // 账号配置摘要（updateBotProfile 会动态补充 robotCode 等字段）
      info: {
        id: self_id,
        accountId: account.accountId,
        clientId: account.clientId,
        platformId: account.platformId,
        robotCode: account.robotCode,
      },
      version: { id: self_id, name: this.name, version: this.version },
      stat: { start_time: Date.now() / 1000 },
      fl: new Map(),
      gl: new Map(),
      gml: new Map(),
      callback: {},

      login: () => this.startAccount(account),
      logout: () => this.stopAccount(account.accountId || account.clientId),
      getFriendMap: () => bot.fl,
      getGroupMap: () => bot.gl,
      getMemberMap: group_id => bot.gml.get(String(group_id)),
      pickFriend: user_id => this.pickFriend(bot, user_id),
      get pickUser() {
        return this.pickFriend
      },
      pickGroup: group_id => this.pickGroup(bot, group_id),
      pickMember: (group_id, user_id) => this.pickMember(bot, group_id, user_id),
      // 创建内部群，返回 group_id（openConversationId）：{ name, owner, members } 均为 userId
      createGroup: options => this.createGroup(account, options),
      // 互动卡片 API：完全走开放接口操作卡片实例
      createCard: body => this.createCard(account, body),
      createAndDeliverCard: body => this.createAndDeliverCard(account, body),
      deliverCard: body => this.deliverCard(account, body),
      updateCard: body => this.updateCard(account, body),
      closeCardTop: (outTrackId, openConversationId) => this.closeCardTop(account, outTrackId, openConversationId),
      streamingUpdateCard: options => this.streamingUpdateCard(account, options),
      registerCardCallback: options => this.registerCardCallback(account, options),
      appendCardSpaces: body => this.appendCardSpaces(account, body),
      copyCardTemplate: templateId => this.copyCardTemplate(account, templateId),
    }
    Bot[self_id] = bot
    Bot.bots[self_id] = bot
    if (!Bot.uin.includes(self_id)) Bot.uin.push(self_id)
    return bot
  }

  // 首个回调学习 platformId：与当前 bot id 一致时仅回写配置；已存在同 id bot 则迁移入口；
  // 否则就地替换 Bot 表中旧 id
  bindPlatformId(entry, platformId) {
    if (!platformId) return entry.bot
    const value = String(platformId)
    const id = this.platformKey(value)
    const bot = entry.bot
    if (bot.self_id === id) {
      bot.dingtalk_id = value
      if (entry.config.platformId !== value) {
        entry.config.platformId = value
        configSave()
      }
      return bot
    }
    const oldId = bot.self_id
    const existing = Bot[id]
    if (existing && existing !== bot && existing.adapter === this) {
      entry.bot = existing
      return existing
    }
    delete Bot[oldId]
    delete Bot.bots[oldId]
    const index = Bot.uin.findIndex(value => value === oldId)
    if (index >= 0) Bot.uin[index] = id
    bot.self_id = id
    bot.uin = id
    bot.dingtalk_id = value
    if (entry.config.platformId !== value) {
      entry.config.platformId = value
      configSave()
    }
    Bot[id] = bot
    Bot.bots[id] = bot
    return bot
  }

  pickFriend(bot, user_id, context = {}) {
    user_id = String(user_id)
    const info = { ...(bot.fl.get(user_id) || {}), user_id, self_id: bot.self_id, ...context }
    return {
      ...info,
      sendMsg: message => this.sendMessage(bot, info, message),
      sendFile: (file, name) => this.sendMessage(bot, info, [{ type: "file", file, name }]),
      getInfo: async () => info,
    }
  }

  pickMember(bot, group_id, user_id) {
    return {
      ...this.pickFriend(bot, user_id),
      group_id: String(group_id),
      user_id: String(user_id),
    }
  }

  pickGroup(bot, group_id, context = {}) {
    group_id = String(group_id)
    const info = { ...(bot.gl.get(group_id) || {}), group_id, self_id: bot.self_id, ...context }
    return {
      ...info,
      sendMsg: message => this.sendMessage(bot, info, message),
      sendFile: (file, name) => this.sendMessage(bot, info, [{ type: "file", file, name }]),
      pickMember: user_id => this.pickMember(bot, group_id, user_id),
      getInfo: async () => info,
      // 修改群名（仅支持本插件创建的群，钉钉限制：chatid 只有创建群接口会返回）
      setGroupName: name => this.setGroupName(this.configFor(bot), group_id, name),
      // 拉人进群，可传单个 userId 或数组
      addMember: user_id => this.addGroupMember(this.configFor(bot), group_id, user_id),
    }
  }

  // 图片段 → 公网 URL：优先图床 Bot.imageToUrl，失败回退 Bot.fileToUrl
  async makeImageUrl(data) {
    const file = await Bot.fileType(data, { http: true })
    let url
    if (typeof Bot.imageToUrl === "function") {
      try {
        url = await Bot.imageToUrl(file, { name: file.name })
      } catch (error) {
        this.log("warn", null, "图床上传失败，改用本地图片地址", error)
      }
    }
    return url || await Bot.fileToUrl(file)
  }

  // 仅含 image/audio/record/video/file 段的顶层消息返回段数组（webhook 不支持这些类型，改走接口方式），否则 null
  pickMedia(message) {
    const segments = Array.isArray(message) ? message : [message]
    const out = []
    for (let segment of segments) {
      if (segment === null || segment === undefined) continue
      if (typeof segment !== "object") return null
      if (!["image", "audio", "record", "music", "video", "file"].includes(segment.type)) return null
      out.push({ ...segment, data: segment.data || segment })
    }
    return out
  }

  // 上传媒体文件获取 media_id（type: image/voice/video/file，media_id 可复用，photoURL 等参数可直接填 mediaId）
  // 限制：image 20MB（jpg/gif/png/bmp），video 20MB（mp4），file 20MB；voice 仅接受 amr，非 amr 语音先经 ffmpeg 转码
  async uploadMedia(account, type, file) {
    let buffer = file.buffer || file.file
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(await (await fetch(file.url)).arrayBuffer())
    const form = new FormData()
    form.append("type", type)
    form.append("media", new Blob([buffer]), file.name || "file")
    const response = await fetch(`https://oapi.dingtalk.com/media/upload?access_token=${account.accessToken}`, {
      method: "POST",
      body: form,
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || data.errcode)
      throw new Error(`上传 DingTalk 媒体文件失败: ${Bot.String(data)}`)
    return data.media_id
  }

  // 执行外部命令，返回 stdout；退出码非 0 时抛错
  runCmd(cmd, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args)
      let stdout = ""
      child.stdout.on("data", chunk => (stdout += chunk))
      child.on("error", reject)
      child.on("exit", code => (code ? reject(new Error(`${cmd} 退出码 ${code}`)) : resolve(stdout)))
    })
  }

  // 转码为 amr（钉钉 voice 上传仅接受 amr），返回 { name, buffer, duration(秒) }
  // silk 语音（shareMusic 等插件产出）ffmpeg 无法解码，先经 silk-wasm 解码为 pcm 再转
  async convertAmr(file) {
    const input = path.join(tmpdir(), `dingtalk-${Date.now()}`)
    const output = `${input}.amr`
    let buffer = file.buffer
    // silk 数据头部自带 0x02 前缀（silk-wasm 编码/QQ 语音均如此），decode 需保留原样传入
    if (buffer.subarray(0, 10).toString().includes("#!SILK")) {
      const { decode } = await import("silk-wasm")
      buffer = (await decode(buffer, 24000)).data
      await writeFile(input, buffer)
      await this.runCmd("ffmpeg", ["-y", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", input, "-ar", "8000", "-ac", "1", "-ab", "12.2k", output])
    } else {
      await writeFile(input, buffer)
      await this.runCmd("ffmpeg", ["-y", "-i", input, "-ar", "8000", "-ac", "1", "-ab", "12.2k", output])
    }
    try {
      const duration = Number(await this.runCmd("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", output])) || 0
      return {
        name: `${String(file.name || "audio").replace(/\.\w+$/, "")}.amr`,
        type: { ext: "amr" },
        buffer: await readFile(output),
        duration,
      }
    } finally {
      rm(input, { force: true }).catch(() => {})
      rm(output, { force: true }).catch(() => {})
    }
  }

  // ffprobe 探测本地视频文件 duration(秒)/width/height，失败抛错由调用方降级
  async probeVideo(input) {
    const json = JSON.parse(await this.runCmd("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", input]))
    const stream = json.streams?.find(item => item.codec_type === "video")
    return {
      duration: Number(json.format?.duration || stream?.duration) || 0,
      width: stream?.width,
      height: stream?.height,
    }
  }

  // ffmpeg 抽取视频首帧为 jpg 封面，失败抛错由调用方降级
  async extractPoster(input) {
    const output = `${input}-poster.jpg`
    try {
      await this.runCmd("ffmpeg", ["-y", "-i", input, "-frames:v", "1", "-q:v", "2", output])
      return { name: "poster.jpg", buffer: await readFile(output) }
    } finally {
      rm(output, { force: true }).catch(() => {})
    }
  }

  // 媒体段 → 接口方式 msgParam：统一上传 mediaId（本地/网页/base64/dataURL 源由 Bot.fileType 统一处理）
  // 兼容两种段结构：{ type, data } 与 oicq 平铺 { type, file, name }
  async makeMediaParam(account, segment) {
    const data = segment.data || segment
    switch (segment.type) {
      case "image": {
        const file = await Bot.fileType(data, { http: true })
        return { photoURL: await this.uploadMedia(account, "image", file) }
      }
      case "audio":
      case "record": {
        // 钉钉 voice 上传仅接受 amr：有 ffmpeg 时转码为 amr 走语音气泡，失败降级为文件附件发送
        // http:true 时 Bot.fileType 的 buffer 可能是 URL 字符串，转码前统一取真实 Buffer
        const file = await Bot.fileType(data, { http: true })
        if (!Buffer.isBuffer(file.buffer)) file.buffer = Buffer.from(await (await fetch(file.url)).arrayBuffer())
        try {
          const amr = file.type?.ext === "amr" ? file : await this.convertAmr(file)
          const duration = Number(data.duration || amr.duration || 0)
          return { mediaId: await this.uploadMedia(account, "voice", amr), duration: String(Math.round(duration * 1000)) }
        } catch (error) {
          this.log("debug", account.accountId, "语音转码失败，降级为文件附件发送", error)
          const name = data.name || file.name || "audio.mp3"
          return {
            mediaId: await this.uploadMedia(account, "file", file),
            fileName: name,
            fileType: name.split(".").pop() || "mp3",
          }
        }
      }
      case "video": {
        // 官方参数：videoMediaId / videoType(仅 mp4) / duration(秒) / picMediaId(封面) / height / width(px)
        // http:true 时 Bot.fileType 的 buffer 可能是 URL 字符串，统一取真实 Buffer
        const file = await Bot.fileType(data, { http: true })
        let buffer = file.buffer
        if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(await (await fetch(file.url || buffer)).arrayBuffer())
        // 写入临时文件供 ffprobe 探测与 ffmpeg 抽帧，用完清理
        const input = path.join(tmpdir(), `dingtalk-video-${Date.now()}`)
        await writeFile(input, buffer)
        try {
          const probe = await this.probeVideo(input).catch(() => ({}))
          const param = {
            videoMediaId: await this.uploadMedia(account, "video", { name: file.name, buffer }),
            videoType: "mp4",
            duration: String(Math.round(Number(data.duration || probe.duration || 0))),
          }
          if (probe.height) param.height = probe.height
          if (probe.width) param.width = probe.width
          // 封面：段携带 pic/cover 优先，否则抽取视频首帧
          const pic = data.pic || data.cover || data.thumb
          if (pic) {
            try {
              const cover = await Bot.fileType({ file: String(pic).replaceAll("`", "") }, { http: true })
              param.picMediaId = await this.uploadMedia(account, "image", cover)
            } catch {}
          } else {
            const poster = await this.extractPoster(input).catch(() => null)
            if (poster) param.picMediaId = await this.uploadMedia(account, "image", poster)
          }
          return param
        } finally {
          rm(input, { force: true }).catch(() => {})
        }
      }
      case "music": {
        // 音乐分享卡 → sampleLink：标题 + 简介 + 封面（上传 media_id）+ 跳转地址
        const card = segment.data || segment
        let picUrl = ""
        if (card.image) {
          try {
            const cover = await Bot.fileType({ file: String(card.image).replaceAll("`", "") }, { http: true })
            picUrl = await this.uploadMedia(account, "image", cover)
          } catch {}
        }
        const title = card.title || "音乐分享"
        return {
          text: card.content ? `${title} - ${card.content}` : title,
          title,
          picUrl,
          messageUrl: String(card.url || card.audio || "").replaceAll("`", ""),
        }
      }
      case "file": {
        const file = await Bot.fileType(data, { http: true })
        const name = data.name || file.name || "file"
        return { mediaId: await this.uploadMedia(account, "file", file), fileName: name, fileType: name.split(".").pop() }
      }
    }
  }

  // 接口方式发送机器人消息：群聊 groupMessages/send，单聊 oToMessages/batchSend
  async sendRobotMessage(account, data, msgKey, msgParam) {
    const isGroup = data.group_id
    const url = isGroup
      ? "https://api.dingtalk.com/v1.0/robot/groupMessages/send"
      : "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend"
    const body = isGroup
      ? { msgKey, msgParam, openConversationId: data.group_id, robotCode: account.robotCode || account.clientId }
      : {
          msgKey,
          msgParam,
          robotCode: account.robotCode || account.clientId,
          userIds: [data.dingtalk_event?.senderStaffId || data.user_id],
        }
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": account.accessToken },
      body: JSON.stringify(body),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok || result.code)
      throw new Error(`DingTalk 媒体发送失败: ${Bot.String(result)}`)
    return result
  }

  // ===== 互动卡片 API（完全走开放接口操作卡片实例）=====

  // 互动卡片接口统一请求：失败时抛出含响应体的错误
  async cardRequest(account, method, path, params = {}) {
    const query = params.query ? `?${new URLSearchParams(params.query)}` : ""
    const response = await fetch(`https://api.dingtalk.com${path}${query}`, {
      method,
      headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": account.accessToken },
      body: params.body ? JSON.stringify(params.body) : undefined,
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok || result.success === false)
      throw new Error(`DingTalk 卡片接口 ${path} 失败: ${Bot.String(result)}`)
    return result
  }

  // 创建卡片（仅创建不投放）：body 含 cardTemplateId/outTrackId/cardData/privateData/openSpaceModels 等
  createCard(account, body) {
    return this.cardRequest(account, "POST", "/v1.0/card/instances", { body })
  }

  // 创建并投放卡片：openSpaceId 格式 dtv1.card//IM_GROUP.{openConversationId}（群）或 dtv1.card//IM_ROBOT.{userId}（机器人单聊）
  createAndDeliverCard(account, body) {
    return this.cardRequest(account, "POST", "/v1.0/card/instances/createAndDeliver", { body })
  }

  // 投放已创建的卡片实例：openSpaceId 支持分号分隔多场域，openDeliverModel 携带各场域差异化属性（如 robotCode）
  deliverCard(account, body) {
    return this.cardRequest(account, "POST", "/v1.0/card/instances/deliver", { body })
  }

  // 更新卡片数据：cardData/privateData 全量覆盖，cardUpdateOptions.updateCardDataByKey=true 按 key 更新
  updateCard(account, body) {
    return this.cardRequest(account, "PUT", "/v1.0/card/instances", { body })
  }

  // 关闭吊顶卡片：query 传 outTrackId + openConversationId
  closeCardTop(account, outTrackId, openConversationId) {
    return this.cardRequest(account, "POST", "/v1.0/card/tops/close", { query: { outTrackId, openConversationId } })
  }

  // AI 卡片流式更新（打字机效果）：markdown 变量必须 isFull=true 且全量内容，单次 content ≤1KB
  streamingUpdateCard(account, { outTrackId, key, content, isFull = true, isFinalize = false, isError = false }) {
    return this.cardRequest(account, "PUT", "/v1.0/card/streaming", {
      body: { outTrackId, key, content, guid: randomUUID(), isFull, isFinalize, isError },
    })
  }

  // 注册卡片回调地址（HTTP 回调模式用；callbackType=STREAM 时无需注册）
  registerCardCallback(account, { callbackRouteKey, callbackUrl, apiSecret, forceUpdate }) {
    return this.cardRequest(account, "POST", "/v1.0/card/callbacks/register", {
      body: { callbackRouteKey, callbackUrl, apiSecret, forceUpdate },
    })
  }

  // 新增或更新卡片实例的场域信息，使已创建的卡片可投放到对应场域
  appendCardSpaces(account, body) {
    return this.cardRequest(account, "PUT", "/v1.0/card/instances/spaces", { body })
  }

  // 卡片平台模板复制：根据 templateId 复制模板（官方标注仅第三方企业应用支持）
  copyCardTemplate(account, templateId) {
    return this.cardRequest(account, "POST", "/v1.0/card/templates/copy", { body: { templateId } })
  }

  // 消息段 → 钉钉消息正文：默认纯文本（plain=false 时用 Markdown 语法），
  // 图片经图床/本地转 URL，文件转下载链接，node 递归展开
  async renderMessage(message, plain = true) {
    const out = []
    for (let segment of Array.isArray(message) ? message : [message]) {
      if (segment === null || segment === undefined) continue
      if (typeof segment !== "object") segment = { type: "text", text: String(segment) }
      if (!segment.data) segment = { ...segment, data: segment }
      const data = segment.data || segment
      switch (segment.type) {
        case "text":
          out.push(data.text || data.content || "")
          break
        case "at":
          out.push(`@${data.qq === "all" ? "所有人" : data.qq} `)
          break
        case "reply": {
          // 引用渲染（纯文本）：引用内容取消息缓存，以前缀行展示
          const quote = this.messageCache.get(String(data.id))
          if (quote) out.push(`回复：${quote}\n`)
          break
        }
        case "image": {
          const url = await this.makeImageUrl(data)
          out.push(plain ? `${data.summary || "图片"}：${url}` : `![${data.summary || "图片"}](${url})`)
          break
        }
        case "file": {
          const file = await Bot.fileType(data, { http: true })
          const url = await Bot.fileToUrl(file)
          const name = data.name || file.name || "文件"
          out.push(plain ? `${name}：${url}` : `[${name}](${url})`)
          break
        }
        case "markdown":
          // markdown 消息段：正文原样输出（sendMessage 检测到后整条按 Markdown 发送）
          out.push(typeof data === "string" ? data : String(data.content ?? data.text ?? ""))
          break
        case "node":
          for (const node of data || []) out.push(await this.renderMessage(node.message || node, plain))
          break
        case "button":
          break
        case "music": {
          // 音乐分享卡片：钉钉无原生音乐消息，降级为链接消息（sampleLink），仅媒体段独立发送时生效
          break
        }
        default:
          out.push(data.text || segment.type || "")
      }
    }
    return out.join("")
  }

  // 提取按钮：link 按钮转跳转按钮；callback/input 按钮钉钉无点击能力，actionURL 传空仅展示
  getActionButtons(message) {
    const buttons = []
    const visit = item => {
      if (!item) return
      if (Array.isArray(item)) return item.forEach(visit)
      if (typeof item !== "object") return
      if (item.type === "node") return (item.data || []).forEach(node => visit(node.message || node))
      if (typeof item.text === "string") {
        const title = item.text.trim()
        if (!title) return
        if (typeof item.link === "string") {
          const link = item.link.replace(/`/g, "")
          if (/^https?:\/\//i.test(link)) buttons.push({ title, actionURL: link })
          return
        }
        if (typeof item.callback === "string" || typeof item.input === "string")
          buttons.push({ title, actionURL: "" })
        return
      }
      visit(item.data ?? item.button ?? item.buttons)
    }
    visit(message)
    return buttons
  }

  // 提取按钮行结构：Yunzai 按钮段二维数组的每个子数组即一行，保留行划分供互动卡片按行渲染
  getActionButtonRows(message) {
    const rows = []
    const makeButton = item => {
      if (!item || typeof item !== "object" || typeof item.text !== "string") return null
      const title = item.text.trim()
      if (!title) return null
      if (typeof item.link === "string") {
        const link = item.link.replace(/`/g, "")
        return /^https?:\/\//i.test(link) ? { title, actionURL: link } : null
      }
      if (typeof item.callback === "string") return { title, actionURL: "", callback: item.callback }
      if (typeof item.input === "string") return { title, actionURL: "", input: item.input }
      return null
    }
    const visit = item => {
      if (!item) return
      if (Array.isArray(item)) return item.forEach(visit)
      if (typeof item !== "object") return
      if (item.type === "node") return (item.data || []).forEach(node => visit(node.message || node))
      if (item.type === "button" && Array.isArray(item.data)) {
        // 二维数组：每个子数组一行；一维数组：整体作为一行
        for (const line of Array.isArray(item.data[0]) ? item.data : [item.data]) {
          const row = (line || []).map(makeButton).filter(Boolean)
          if (row.length) rows.push(row)
        }
        return
      }
      visit(item.data ?? item.button ?? item.buttons)
    }
    visit(message)
    return rows
  }

  // 是否携带 markdown 消息段（含 node 内层）：携带时整条按 Markdown 消息发送
  hasMarkdown(message) {
    let found = false
    const visit = item => {
      if (found || !item) return
      if (Array.isArray(item)) return item.forEach(visit)
      if (typeof item !== "object") return
      if (item.type === "markdown") found = true
      else if (item.type === "node") for (const node of item.data || []) visit(node.message || node)
    }
    visit(message)
    return found
  }

  // 发送媒体段：转换接口参数后按类型映射 msgKey，语音转码成功（无 fileName）走语音气泡 sampleAudio
  async sendMedia(config, data, segment) {
    const msgParam = await this.makeMediaParam(config, segment)
    const msgKey =
      (segment.type === "audio" || segment.type === "record") && !msgParam.fileName
        ? "sampleAudio"
        : { image: "sampleImageMsg", audio: "sampleFile", record: "sampleFile", music: "sampleLink", video: "sampleVideo", file: "sampleFile" }[segment.type]
    await this.sendRobotMessage(config, data, msgKey, JSON.stringify(msgParam))
  }

  // 发送消息：默认纯文本，携带 markdown 段时整条按 Markdown 发送；提取到按钮时改发 ActionCard（最多 5 个）
  // 回复事件携带 sessionWebhook 优先使用，否则回退账号配置的默认 webhook
  async sendMessage(bot, data, message) {
    const entry = [...this.managedAccounts.values()].find(item => item.bot === bot)
    if (!entry?.config) {
      this.log("error", bot.self_id, "bot 未注册或已断开，无法发送消息")
      return false
    }
    // Markdown 模式判定：携带 markdown 段或全局 Markdown 开关开启（对齐 QQBot md 模式）——
    // 整条渲染为 Markdown 消息，图片内嵌为公网 URL，不做分段
    const segments = Array.isArray(message) ? [...message] : [message]
    const markdown = config.markdown || this.hasMarkdown(segments)
    // 消息分段发送：钉钉单条消息无法图文混排原生图片，按段顺序拆组——
    // 连续媒体段（image/audio/video/file）一组走接口方式，其余段合并一组走 Webhook；
    // Markdown 模式时不分段
    if (!markdown) {
      const MEDIA = ["image", "audio", "record", "music", "video", "file"]
      const groups = []
      for (const seg of segments) {
        const type = seg?.type
        const last = groups[groups.length - 1]
        if (MEDIA.includes(type)) {
          if (last?.media) last.media.push(seg)
          else groups.push({ media: [seg] })
        } else {
          if (last?.media) groups.push({ rest: [seg] })
          else if (last) last.rest.push(seg)
          else groups.push({ rest: [seg] })
        }
      }
      if (groups.length > 1 || (groups.length === 1 && groups[0].media)) {
        for (const group of groups) {
          if (group.rest)
            await this.sendMessage(bot, data, group.rest)
          for (const seg of group.media || []) await this.sendMedia(entry.config, data, seg)
        }
        const target = data.group_id ? `群消息：[${data.group_id}]` : `好友消息：[${data.user_id || "unknown"}]`
        Bot.makeLog("info", [target, `[分段:${groups.length}组]`], this.logId(bot.self_id))
        bot.stat.message_sent = (bot.stat.message_sent || 0) + 1
        return { message_id: `${bot.self_id}_${Date.now().toString(36)}` }
      }
    }
    // 仅媒体段：走接口方式发送；Markdown 模式下图片由正文内嵌渲染（imageToUrl 图床直链），仅其余媒体走接口
    const media = this.pickMedia(markdown ? segments.filter(segment => segment?.type !== "image") : message)
    if (media?.length) {
      for (const segment of media) await this.sendMedia(entry.config, data, segment)
      const target = data.group_id ? `群消息：[${data.group_id}]` : `好友消息：[${data.user_id || "unknown"}]`
      Bot.makeLog("info", [target, `[媒体:${media.length}条]`], this.logId(bot.self_id))
      bot.stat.message_sent = (bot.stat.message_sent || 0) + 1
      return { message_id: `${bot.self_id}_${Date.now().toString(36)}` }
    }
    // 回调触发的模拟消息没有 sessionWebhook：卡片走卡片接口、按钮/正文走机器人消息接口，不在此报错
    const webhook = data.sessionWebhook || entry?.config?.webhook
    const text = (await this.renderMessage(message, !markdown)).trim()
    const buttons = this.getActionButtons(message)
    Bot.makeLog("debug", ["markdown 段:", markdown, "按钮:", buttons.length, buttons], this.logId(bot.self_id))
    if (!text && !buttons.length) return false
    // 互动卡片模式：配置 cardTemplateId 后正文与按钮合并为一张互动卡片投放，
    // 按钮数量不限：link → openLink 事件，callback/input → sendCardRequest 回传事件（Stream 回调接收）
    if (config.cardTemplateId) {
      const outTrackId = `yz_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`
      const robotCode = entry.config.robotCode || entry.config.clientId
      // 卡片按行渲染按钮：Yunzai 按钮段二维数组每个子数组一行，模板提供 row1~row5 五个按钮组
      const rows = this.getActionButtonRows(message)
      if (rows.length > 5)
        this.log("warn", bot.self_id, "钉钉互动卡片最多渲染 5 行按钮，多余行已合并至末行")
      const cardRows = [...rows.slice(0, 4), ...(rows.length > 4 ? [rows.slice(4).flat()] : [])]
      let actionIndex = 0
      const toCardButton = button => ({
        text: button.title,
        color: "blue",
        status: "normal",
        event: button.actionURL
          ? { type: "openLink", params: { url: button.actionURL } }
          : {
              type: "sendCardRequest",
              params: { actionId: `action_${actionIndex++}`, params: { action: button.callback || button.input || "" } },
            },
      })
      const [row1, row2, row3, row4, row5] = [0, 1, 2, 3, 4].map(i => (cardRows[i] || []).map(toCardButton))
      const body = {
        cardTemplateId: config.cardTemplateId,
        outTrackId,
        // 卡片创建者 userId
        userId: data.dingtalk_event?.senderStaffId || data.user_id || undefined,
        callbackType: "STREAM",
        userIdType: 1,
        cardData: {
          cardParamMap: {
            content: text || "&nbsp;",
            // 复杂类型（对象数组）变量必须放入 sys_full_json_obj，简单字符串放 cardParamMap 顶层
            sys_full_json_obj: JSON.stringify({ config: { autoLayout: true }, row1, row2, row3, row4, row5 }),
          },
        },
        // openSpaceId 场域标识用小写；场域属性与投放参数为顶层字段（官方 SDK 示例）
        openSpaceId: data.group_id
          ? `dtv1.card//im_group.${data.group_id}`
          : `dtv1.card//im_robot.${data.dingtalk_event?.senderStaffId || data.user_id}`,
        ...(data.group_id
          ? {
              imGroupOpenSpaceModel: { supportForward: true, lastMessageI18n: { ZH_CN: this.cardSummary(text) } },
              imGroupOpenDeliverModel: { robotCode },
            }
          : {
              imRobotOpenSpaceModel: { supportForward: true, lastMessageI18n: { ZH_CN: this.cardSummary(text) } },
              imRobotOpenDeliverModel: { spaceType: "IM_ROBOT", robotCode },
            }),
      }
      await this.createAndDeliverCard(entry.config, body)
      // 记录卡片场域映射，回调点击时据此刻别群/单聊
      this.setCache(this.cardSpaces, outTrackId, {
        group_id: data.group_id || "",
        user_id: String(body.userId || data.user_id || ""),
      })
      const target = data.group_id ? `群消息：[${data.group_id}]` : `好友消息：[${data.user_id || "unknown"}]`
      const count = cardRows.reduce((sum, row) => sum + row.length, 0)
      Bot.makeLog("info", [target, `[互动卡片:${cardRows.length}行${count}按钮] ${text}`], this.logId(bot.self_id))
      bot.stat.message_sent = (bot.stat.message_sent || 0) + 1
      return { message_id: outTrackId }
    }
    // 按钮：接口方式按数量选 msgKey——1个 sampleActionCard（singleTitle/singleURL），
    // 2~5个 sampleActionCard2~5（actionTitleN/actionURLN 竖向排布），各 msgKey 字段布局互不兼容
    if (buttons.length) {
      if (buttons.length > 5)
        this.log("warn", bot.self_id, "钉钉 ActionCard 最多支持 5 个按钮，已截取前 5 个")
      const cardButtons = buttons.slice(0, 5)
      const msgParam = { title: bot.nickname || "DingTalk", text: text || "&nbsp;" }
      let msgKey
      if (cardButtons.length === 1) {
        msgKey = "sampleActionCard"
        msgParam.singleTitle = cardButtons[0].title
        msgParam.singleURL = cardButtons[0].actionURL
      } else {
        msgKey = `sampleActionCard${cardButtons.length}`
        cardButtons.forEach((button, index) => {
          msgParam[`actionTitle${index + 1}`] = button.title
          msgParam[`actionURL${index + 1}`] = button.actionURL
        })
      }
      await this.sendRobotMessage(entry.config, data, msgKey, JSON.stringify(msgParam))
      const target = data.group_id ? `群消息：[${data.group_id}]` : `好友消息：[${data.user_id || "unknown"}]`
      Bot.makeLog("info", [target, `[ActionCard:${cardButtons.length}按钮] ${text}`], this.logId(bot.self_id))
      bot.stat.message_sent = (bot.stat.message_sent || 0) + 1
      return { message_id: `${bot.self_id}_${Date.now().toString(36)}` }
    }
    const payload = markdown
      ? { msgtype: "markdown", markdown: { title: bot.nickname || "DingTalk", text } }
      : { msgtype: "text", text: { content: text } }
    if (webhook) await this.postWebhook(webhook, payload)
    else
      // 无 webhook（如卡片回调触发的模拟消息）时回退机器人消息接口
      await this.sendRobotMessage(
        entry.config,
        data,
        markdown ? "sampleMarkdown" : "sampleText",
        JSON.stringify(markdown ? { title: bot.nickname || "DingTalk", text } : { content: text }),
      )
    const target = data.group_id ? `群消息：[${data.group_id}]` : `好友消息：[${data.user_id || "unknown"}]`
    Bot.makeLog("info", [target, text], this.logId(bot.self_id))
    bot.stat.message_sent = (bot.stat.message_sent || 0) + 1
    return { message_id: `${bot.self_id}_${Date.now().toString(36)}` }
  }

  // POST webhook 消息，errcode 非 0 抛错
  async postWebhook(webhook, payload) {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok || result.errcode) throw new Error(`DingTalk 发送失败: ${Bot.String(result)}`)
    return result
  }

  // Stream 消息体 → Yunzai 事件：解析 @ 提及与媒体（downloadCode 换 CDN 地址），补全用户资料
  async decode(body, bot, account) {
    const user_id = String(body.senderStaffId || body.senderId || "unknown")
    const isGroup = String(body.conversationType) === "2"
    const text = String(body.text?.content || "").trim()
    const message = text ? [{ type: "text", text }] : []

    let userInfo = {}
    if (user_id !== "unknown") {
      try {
        userInfo = await this.getUserInfo(account, user_id)
      } catch (error) {
        const errorKey = `${account.accountId || account.clientId}:${user_id}`
        if (!this.getCache(this.userInfoErrors, errorKey)) {
          this.setCache(this.userInfoErrors, errorKey, true, 600000)
          this.log("warn", bot.self_id, "获取用户头像/昵称失败，已使用消息事件信息", error)
        }
      }
    }

    // @ 提及：机器人 id 命中时置 atme 并补 at 段，其余成员转为普通 at 段。
    // 注意：逐条 unshift，最终段顺序与 atUsers 相反（保持原有行为）
    const botAtIds = new Set(
      [body.chatbotUserId, body.robotCode, account.robotCode, account.chatbotUserId]
        .filter(Boolean)
        .map(String),
    )
    let botAt = false
    for (const at of body.atUsers || []) {
      const candidates = [at.staffId, at.dingtalkId].filter(Boolean).map(String)
      const id = candidates[0]
      if (!id) continue
      if (candidates.some(candidate => botAtIds.has(candidate))) {
        botAt = true
        message.unshift({ type: "at", qq: bot.self_id })
      } else {
        message.unshift({ type: "at", qq: String(id) })
      }
    }
    // 部分事件仅携带 isInAtList，不含机器人 id
    if (body.isInAtList && !botAt) message.unshift({ type: "at", qq: bot.self_id })

    if (body.msgtype === "picture" && body.content?.downloadCode) {
      const url = await this.downloadFile(account, body.content.downloadCode)
      message.push({ type: "image", url, file: url })
    }
    if (body.msgtype === "file" && body.content?.downloadCode) {
      const url = await this.downloadFile(account, body.content.downloadCode)
      message.push({ type: "file", url, file: url, name: body.content.fileName })
    }
    // 单聊中用户可发送语音/视频给机器人（群聊不支持），事件同样携带 downloadCode
    if (body.msgtype === "audio" && body.content?.downloadCode) {
      const url = await this.downloadFile(account, body.content.downloadCode)
      message.push({ type: "audio", url, file: url })
    }
    if (body.msgtype === "video" && body.content?.downloadCode) {
      const url = await this.downloadFile(account, body.content.downloadCode)
      message.push({ type: "video", url, file: url })
    }
    if (body.msgtype === "richText")
      for (const item of body.content?.richText || []) {
        if (item.text) message.push({ type: "text", text: item.text })
        const code = item.downloadCode || item.pictureDownloadCode
        if (code) {
          const url = await this.downloadFile(account, code)
          message.push({ type: "image", url, file: url })
        }
      }
    if (!message.length) return null

    const nickname = body.senderNick || userInfo.name || userInfo.nickname || user_id
    const sender = {
      user_id,
      nickname,
      avatar: body.senderAvatar || userInfo.avatar || "",
      card: nickname,
      role: body.isAdmin ? "admin" : "member",
    }
    bot.fl.set(user_id, sender)
    const data = {
      bot,
      adapter_id: this.id,
      adapter_name: this.name,
      post_type: "message",
      message_type: isGroup ? "group" : "private",
      sub_type: "normal",
      self_id: bot.self_id,
      user_id,
      message_id: String(body.msgId || Date.now()),
      raw_message: text,
      message,
      sender,
      nickname,
      avatar: sender.avatar,
      time: Math.floor(Number(body.createAt || Date.now()) / 1000),
      // 回复 webhook：钉钉要求回复走事件附带的 sessionWebhook
      sessionWebhook: body.sessionWebhook,
      conversationId: body.conversationId,
      dingtalk_event: body,
      atme: botAt || Boolean(body.isInAtList),
    }
    // 缓存收到的消息内容，供 reply 段渲染引用；媒体消息用类型占位
    const placeholders = { picture: "[图片]", file: "[文件]", audio: "[语音]", video: "[视频]" }
    this.cacheMessage(data.message_id, data.raw_message || placeholders[body.msgtype] || "")
    if (isGroup) {
      data.group_id = String(body.conversationId)
      data.group_name = body.conversationTitle || "DingTalk 群聊"
      data.group = this.pickGroup(bot, data.group_id, data)
    } else {
      data.friend = this.pickFriend(bot, user_id, data)
    }
    return data
  }

  // 卡片外显摘要：从正文提取纯文本（图片→[图片]，去 Markdown 语法与多余空白），截断 30 字
  cardSummary(text) {
    const summary = String(text || "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "[图片]")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[#*`>~\-|]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 30)
    return summary || "收到一条卡片消息"
  }

  // 卡片按钮点击回调：对齐 QQBot 适配器范式，构造按钮点击消息事件进入 Yunzai 管线，
  // callback/input 按钮内容作为点击者的消息触发插件处理，回复经机器人消息接口返回
  makeCardCallback(entry, body, action) {
    const bot = entry.bot
    const user_id = String(body.userId)
    const spaceId = String(body.spaceId || "")
    // 群/单聊判断优先查发送卡片时记录的场域映射（outTrackId -> { group_id, user_id }），
    // bot.gl 依赖适配器收到过该群真实消息才填充，不可靠；未命中时才回退 gl 兜底
    const space = this.getCache(this.cardSpaces, String(body.outTrackId || "")) || {}
    const groupId = space.group_id || (bot.gl.has(spaceId) ? spaceId : "")
    const isGroup = Boolean(groupId)
    const data = {
      bot,
      adapter_id: this.id,
      adapter_name: this.name,
      post_type: "message",
      message_type: isGroup ? "group" : "private",
      // 预置 isGroup/isPrivate：避免 loader.checkLimit 在 dealEvent 前把无 group_id 的事件当群消息误入冷却拦截
      isGroup,
      isPrivate: !isGroup,
      sub_type: "callback",
      self_id: bot.self_id,
      user_id: isGroup ? String(space.user_id || user_id) : user_id,
      message_id: `event_${body.outTrackId || Date.now().toString(36)}`,
      raw_message: action,
      message: [{ type: "text", text: action }],
      sender: { user_id, nickname: user_id, avatar: "", card: user_id, role: "member" },
      nickname: user_id,
      avatar: "",
      time: Math.floor(Date.now() / 1000),
      conversationId: spaceId,
      dingtalk_event: body,
      atme: true,
    }
    bot.fl.set(user_id, data.sender)
    if (isGroup) {
      data.group_id = groupId
      data.group = this.pickGroup(bot, groupId, data)
      Bot.makeLog("info", [`群按钮点击事件：[${groupId}, ${data.user_id}]`, action], bot.self_id)
    } else {
      data.friend = this.pickFriend(bot, user_id, data)
      Bot.makeLog("info", [`好友按钮点击事件：[${user_id}]`, action], bot.self_id)
    }
    bot.stat.message_received = (bot.stat.message_received || 0) + 1
    this.log(
      "debug",
      bot.self_id,
      "回调事件派发:",
      JSON.stringify({ event: `message.${data.message_type}`, user_id: data.user_id, message_type: data.message_type, sub_type: data.sub_type, raw_message: data.raw_message }),
    )
    // 与真实好友/群消息完全一致的事件名，确保进入同一处理管线
    Bot.em(`message.${data.message_type}`, data)
  }

  // Stream 推送分发：SYSTEM ping 原样回应保活；CALLBACK 学习 platformId、
  // 回填机器人资料、解码派发 Yunzai 消息事件，最后 ACK（不回应钉钉会重推）
  handleStreamMessage(entry, raw) {
    Promise.resolve()
      .then(async () => {
        const envelope = JSON.parse(raw.toString())
        // 非 ping/CALLBACK 帧记 debug，排查「连接正常但收不到消息」时确认服务端是否有推送
        Bot.makeLog("debug", ["Stream 推送", envelope.type, envelope.headers?.topic], this.logId(entry.bot.self_id))
        if (envelope.type === "SYSTEM" && envelope.headers?.topic === "ping")
          return entry.socket.send(
            JSON.stringify({ code: 200, headers: envelope.headers, message: "OK", data: envelope.data }),
          )
        if (envelope.type !== "CALLBACK") return
        // 互动卡片回调事件（callbackType=STREAM）：按钮点击/回传请求，透传给脚本监听
        if (envelope.headers?.topic === "/v1.0/card/instances/callback") {
          const body = typeof envelope.data === "string" ? JSON.parse(envelope.data) : envelope.data
          this.log("debug", entry.bot.self_id, "卡片回调", Bot.String(body))
          Bot.em(`notice.cardCallback.${entry.bot.self_id}`, { bot: entry.bot, ...body })
          // 按钮回调自动处理：value/content 为 JSON 字符串，解析出回传指令后模拟点击用户的消息事件
          const parseValue = value => {
            try { return typeof value === "string" ? JSON.parse(value) : value } catch { return null }
          }
          const action = (parseValue(body.value) || parseValue(body.content))?.cardPrivateData?.params?.action
          if (action) this.makeCardCallback(entry, body, action)
          if (envelope.headers?.messageId)
            entry.socket.send(
              JSON.stringify({
                code: 200,
                headers: { ...envelope.headers, content_type: "application/json" },
                message: "OK",
                data: JSON.stringify({ status: "SUCCESS", message: "OK" }),
              }),
            )
          return
        }
        const body = typeof envelope.data === "string" ? JSON.parse(envelope.data) : envelope.data
        this.bindPlatformId(entry, body.chatbotUserId)
        await this.updateBotProfile(entry, body)
        const data = await this.decode(body, entry.bot, entry.config)
        if (data) {
          entry.bot.stat.message_received = (entry.bot.stat.message_received || 0) + 1
          this.log(
            "info",
            entry.bot.self_id,
            data.message_type === "group"
              ? `群消息：[${data.group_id}, ${data.user_id}] ${data.raw_message}`
              : `好友消息：[${data.user_id}] ${data.raw_message}`,
          )
          Bot.em(`message.${data.message_type}`, data)
        }
        if (envelope.headers?.messageId)
          entry.socket.send(
            JSON.stringify({
              code: 200,
              headers: { ...envelope.headers, content_type: "application/json" },
              message: "OK",
              data: JSON.stringify({ status: "SUCCESS", message: "OK" }),
            }),
          )
      })
      .catch(error => this.log("error", entry.bot.self_id, "Stream 消息处理失败", error))
  }
})()

Bot.adapter.push(adapter)

export class DingTalkPlugin extends plugin {
  constructor() {
    super({
      name: "DingTalk",
      dsc: "DingTalk 钉钉机器人适配器设置",
      event: "message",
      priority: -1000,
      rule: [
        {
          reg: "^#?DingTalk账号$",
          fnc: "List",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ing[Tt]alk设置.+:.+$",
          fnc: "Set",
          permission: config.permission,
        },
      ],
    })
  }

  List() {
    const accounts = Array.isArray(config.dingdingAccounts) ? config.dingdingAccounts : []
    if (!accounts.length) return this.reply("当前没有配置 DingTalk 账号", true)
    const text = accounts
      .map((item, index) => {
        const status = adapter.managedAccounts.get(item.accountId)?.bot ? "已注册" : "未连接"
        return `${index + 1}. ${item.accountId || "未命名"} (${item.clientId || "未配置 AppKey"}) - ${status}`
      })
      .join("\n")
    return this.reply(`DingTalk 账号：\n${text}`, true)
  }

  // 设置账号：#DingTalk设置AppKey:AppSecret[:默认Webhook]（格式由正则校验，账号标识直接使用 AppKey）
  async Set() {
    const parts = this.e.msg.replace(/^#[Dd]ing[Tt]alk设置/, "").trim().split(":")
    const clientId = parts.shift()
    const clientSecret = parts.shift()
    const webhook = parts.join(":")
    const accountId = clientId
    const accounts = Array.isArray(config.dingdingAccounts) ? config.dingdingAccounts : []
    const old = accounts.find(item => item.accountId === accountId)
    const account = {
      ...(old || {}),
      accountId,
      clientId,
      clientSecret,
      webhook,
      autoReconnect: old?.autoReconnect !== false,
    }
    const index = accounts.findIndex(item => item.accountId === accountId)
    if (index === -1) accounts.push(account)
    else accounts[index] = account
    await configSave()
    if (!adapter.managedAccounts.get(accountId)?.bot) {
      await adapter.startAccount(account).catch(error => this.reply(`账号 ${accountId} 连接失败：${error.message}`, true))
    }
    return this.reply(`账号 ${accountId} 已保存并尝试连接。`, true)
  }
}

logger.info(logger.green("- DingTalk 适配器插件 加载完成"))

// 配置热重载：核心 watcher 监听 yaml 变化并 merge 进 config 对象（5 秒防抖），本监听器在
// 同一文件变化后延迟对比（晚于核心 watcher 的 5 秒防抖 merge，确保读到最新配置）
// 对比时剔除适配器自动学习回写的字段（platformId/robotCode/chatIds 等），仅用户可编辑项触发重连
const AUTO_FIELDS = new Set(["platformId", "robotCode", "chatIds", "lastConversationId", "accessToken", "tokenTimer"])
const accountSignature = account =>
  JSON.stringify(Object.fromEntries(Object.entries(account || {}).filter(([key]) => !AUTO_FIELDS.has(key))))
let oldAccounts = new Map(
  (Array.isArray(config.dingdingAccounts) ? config.dingdingAccounts : []).map(item => [item.accountId, accountSignature(item)]),
)
chokidar.watch(configFile).on("change", _.debounce(async () => {
  const accounts = Array.isArray(config.dingdingAccounts) ? config.dingdingAccounts : []
  const cur = new Map(accounts.map(item => [item.accountId, accountSignature(item)]))
  for (const [accountId, signature] of cur) {
    if (oldAccounts.get(accountId) === signature) continue
    const account = accounts.find(item => item.accountId === accountId)
    await adapter.stopAccount(accountId).catch(() => {})
    await adapter.startAccount(account).catch(error =>
      Bot.makeLog("error", ["账号重载失败", error], accountId, true),
    )
  }
  for (const accountId of oldAccounts.keys())
    if (!cur.has(accountId)) await adapter.stopAccount(accountId).catch(() => {})
  oldAccounts = cur
}, 6000))
