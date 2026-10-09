logger.info(logger.yellow("- 正在加载 DingTalk 适配器插件"))

import { readFileSync } from "fs"
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
        subscriptions: [{ type: "CALLBACK", topic: "/v1.0/im/bot/messages/get" }],
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

  // 仅含 image/audio/video/file 段的顶层消息返回段数组（webhook 不支持这些类型，改走接口方式），否则 null
  pickMedia(message) {
    const segments = Array.isArray(message) ? message : [message]
    const out = []
    for (let segment of segments) {
      if (segment === null || segment === undefined) continue
      if (typeof segment !== "object") return null
      if (!["image", "audio", "video", "file"].includes(segment.type)) return null
      out.push({ ...segment, data: segment.data || segment })
    }
    return out
  }

  // 上传媒体文件获取 media_id（type: image/voice/video/file，media_id 可复用，photoURL 等参数可直接填 mediaId）
  // 限制：image 20MB（jpg/gif/png/bmp），voice 2MB（amr/mp3/wav），video 20MB（mp4），file 20MB
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

  // 媒体段 → 接口方式 msgParam：统一上传 mediaId（本地/网页/base64/dataURL 源由 Bot.fileType 统一处理）
  async makeMediaParam(account, segment) {
    const data = segment.data
    switch (segment.type) {
      case "image": {
        const file = await Bot.fileType(data, { http: true })
        return { photoURL: await this.uploadMedia(account, "image", file) }
      }
      case "audio": {
        const file = await Bot.fileType(data, { http: true })
        return { mediaId: await this.uploadMedia(account, "voice", file), duration: String(data.duration || 1000) }
      }
      case "video": {
        const file = await Bot.fileType(data, { http: true })
        // duration 单位秒；videoType 官方仅支持 mp4
        return {
          videoMediaId: await this.uploadMedia(account, "video", file),
          videoType: "mp4",
          duration: String(Math.round(data.duration || 0)),
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
        default:
          out.push(data.text || Bot.String(segment))
      }
    }
    return out.join("")
  }

  // 递归收集 http 跳转按钮（含 node 内层）：转 ActionCard 发送
  getActionButtons(message) {
    const buttons = []
    const visit = item => {
      if (!item) return
      if (Array.isArray(item)) return item.forEach(visit)
      if (typeof item !== "object") return
      const data = item.data || item
      if (item.type === "button") {
        for (const row of Array.isArray(data) ? data : [data]) {
          for (const button of Array.isArray(row) ? row : [row]) {
            const link = button?.link
            if (button?.text && /^https?:\/\//i.test(link || ""))
              buttons.push({ title: String(button.text), actionURL: link })
          }
        }
      } else if (item.type === "node") {
        for (const node of data || []) visit(node.message || node)
      }
    }
    visit(message)
    return buttons
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

  // 发送消息：默认纯文本，携带 markdown 段时整条按 Markdown 发送；提取到按钮时改发 ActionCard（最多 5 个）
  // 回复事件携带 sessionWebhook 优先使用，否则回退账号配置的默认 webhook
  async sendMessage(bot, data, message) {
    const entry = [...this.managedAccounts.values()].find(item => item.bot === bot)
    if (!entry?.config) {
      this.log("error", bot.self_id, "bot 未注册或已断开，无法发送消息")
      return false
    }
    // webhook 不支持图片/语音/文件/视频，仅含媒体段时改走接口方式发送
    const media = this.pickMedia(message)
    if (media?.length) {
      for (const segment of media) {
        const msgParam = await this.makeMediaParam(entry.config, segment)
        const msgKey = { image: "sampleImageMsg", audio: "sampleAudio", video: "sampleVideo", file: "sampleFile" }[segment.type]
        await this.sendRobotMessage(entry.config, data, msgKey, JSON.stringify(msgParam))
      }
      const target = data.group_id ? `群消息：[${data.group_id}]` : `好友消息：[${data.user_id || "unknown"}]`
      Bot.makeLog("info", [target, `[媒体:${media.length}条]`], this.logId(bot.self_id))
      bot.stat.message_sent = (bot.stat.message_sent || 0) + 1
      return { message_id: `${bot.self_id}_${Date.now().toString(36)}` }
    }
    const webhook = data.sessionWebhook || entry?.config?.webhook
    if (!webhook) {
      this.log("error", bot.self_id, "消息缺少 sessionWebhook，且账号未配置 webhook")
      return false
    }
    const markdown = this.hasMarkdown(message)
    const text = (await this.renderMessage(message, !markdown)).trim()
    const buttons = this.getActionButtons(message)
    if (!text && !buttons.length) return false
    if (buttons.length > 5)
      this.log("warn", bot.self_id, "钉钉 ActionCard 最多支持 5 个跳转按钮，已截取前 5 个")
    const cardButtons = buttons.slice(0, 5)
    const payload = cardButtons.length
      ? {
          msgtype: "actionCard",
          actionCard: {
            title: bot.nickname || "DingTalk",
            text: text || " ",
            btnOrientation: "0",
            btns: cardButtons,
          },
        }
      : markdown
        ? { msgtype: "markdown", markdown: { title: bot.nickname || "DingTalk", text } }
        : { msgtype: "text", text: { content: text } }
    await this.postWebhook(webhook, payload)
    const target = data.group_id ? `群消息：[${data.group_id}]` : `好友消息：[${data.user_id || "unknown"}]`
    Bot.makeLog("info", [target, text || "[ActionCard]"], this.logId(bot.self_id))
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
