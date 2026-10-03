logger.info(logger.yellow("- 正在加载 DingTalk 适配器插件"))

import { WebSocket } from "ws"
import config, { configSave } from "./lib/config.js"

const TOPIC = "/v1.0/im/bot/messages/get"

class DingTalkAdapter {
  id = "DingDing"
  name = "DingTalk"
  version = "1.0.0"
  path = this.name
  managedAccounts = new Map()
  userInfoCache = new Map()
  userInfoErrors = new Set()
  groupRobotCache = new Map()
  groupRobotErrors = new Set()

  platformKey(platformId) { return `dd_${encodeURIComponent(String(platformId || "default"))}` }
  log(level, accountId, ...args) { Bot.makeLog(level, args.map(value => Bot.String(value)).join(" "), accountId || this.name, true) }
  load() {
    if (config.enableDingAdapter === false) return this.log("warn", null, "适配器已禁用")
    const accounts = Array.isArray(config.dingdingAccounts) ? config.dingdingAccounts : []
    if (!accounts.length) return this.log("warn", null, "没有配置钉钉账号")
    for (const account of accounts) this.startAccount(account).catch(error => this.log("error", account.accountId, "账号启动失败", error))
  }
  async openStream(account) {
    const response = await fetch("https://api.dingtalk.com/v1.0/gateway/connections/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: account.clientId, clientSecret: account.clientSecret, subscriptions: [{ type: "CALLBACK", topic: TOPIC }] }) })
    const data = await response.json()
    if (!response.ok || !data.endpoint || !data.ticket) throw new Error(`打开 DingTalk Stream 失败: ${Bot.String(data)}`)
    return new WebSocket(`${data.endpoint}?ticket=${encodeURIComponent(data.ticket)}`)
  }
  async getAccessToken(account) {
    const response = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appKey: account.clientId, appSecret: account.clientSecret }) })
    const data = await response.json()
    if (!response.ok || !data.accessToken) throw new Error(`获取 DingTalk access token 失败: ${Bot.String(data)}`)
    account.accessToken = data.accessToken
    clearTimeout(account.tokenTimer)
    const tokenTimer = setTimeout(() => this.getAccessToken(account).catch(error => this.log("error", account.accountId, error)), Math.max(60000, (Number(data.expireIn || 7200) - 300) * 1000))
    // Runtime timer handles must not be included when DingTalk.yaml is serialized.
    Object.defineProperty(account, "tokenTimer", { value: tokenTimer, writable: true, configurable: true })
    return data.accessToken
  }
  async downloadFile(account, downloadCode) {
    if (!downloadCode) return ""
    const response = await fetch("https://api.dingtalk.com/v1.0/robot/messageFiles/download", { method: "POST", headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": account.accessToken }, body: JSON.stringify({ downloadCode, robotCode: account.clientId }) })
    const data = await response.json()
    if (!response.ok || !data.downloadUrl) throw new Error(`下载 DingTalk 文件失败: ${Bot.String(data)}`)
    return data.downloadUrl
  }
  async getUserInfo(account, userId) {
    if (!userId || account.userInfo === false) return {}
    const accountId = String(account.accountId || account.clientId || "default")
    const key = `${accountId}:${userId}`
    const cached = this.userInfoCache.get(key)
    if (cached && cached.expires > Date.now()) return cached.value
    const response = await fetch("https://oapi.dingtalk.com/topapi/v2/user/get", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
      body: new URLSearchParams({ access_token: account.accessToken, language: "zh_CN", userid: String(userId) }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || (data.errcode && Number(data.errcode) !== 0)) throw new Error(`获取 DingTalk 用户详情失败: ${Bot.String(data)}`)
    const value = data.result || {}
    this.userInfoCache.set(key, { value, expires: Date.now() + 86400000 })
    return value
  }
  async getGroupRobots(account, groupId) {
    if (!groupId) return []
    const accountId = String(account.accountId || account.clientId || "default")
    const key = `${accountId}:${groupId}`
    const cached = this.groupRobotCache.get(key)
    if (cached && cached.expires > Date.now()) return cached.value
    const response = await fetch("https://api.dingtalk.com/v1.0/robot/groups/robots/query", {
      method: "POST",
      headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": account.accessToken },
      body: JSON.stringify({ openConversationId: String(groupId) }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`获取 DingTalk 群机器人列表失败: ${Bot.String(data)}`)
    const value = Array.isArray(data.chatbotInstanceVOList) ? data.chatbotInstanceVOList : []
    this.groupRobotCache.set(key, { value, expires: Date.now() + 86400000 })
    return value
  }
  async updateBotProfile(entry, body) {
    if (String(body.conversationType) !== "2" || !body.conversationId) return
    const groupId = String(body.conversationId)
    let robots
    try { robots = await this.getGroupRobots(entry.config, groupId) }
    catch (error) {
      const errorKey = `${entry.config.accountId || entry.config.clientId}:${groupId}`
      if (!this.groupRobotErrors.has(errorKey)) { this.groupRobotErrors.add(errorKey); this.log("warn", entry.bot.self_id, "获取群内机器人资料失败，已使用配置名称/头像", error) }
      return
    }
    const codes = new Set([body.robotCode, entry.config.robotCode, entry.config.clientId].filter(Boolean).map(String))
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
  async startAccount(account) {
    const accountId = String(account.accountId || account.clientId || "default")
    if (!account.clientId || !account.clientSecret) return this.log("error", accountId, "缺少 clientId 或 clientSecret")
    // platformId is learned from DingTalk's first callback and then reused on restart.
    const bot = this.makeBot(this.platformKey(account.platformId || accountId), account)
    let socket
    try { await this.getAccessToken(account); socket = await this.openStream(account) } catch (error) { this.log("error", accountId, error); if (account.autoReconnect !== false) this.scheduleReconnect(account); return }
    const entry = { config: account, bot, socket }
    this.managedAccounts.set(accountId, entry)
    socket.on("open", () => { this.log("mark", bot.self_id, `钉钉机器人 ${bot.self_id} 已连接`); Bot.em(`connect.${bot.self_id}`, { self_id: bot.self_id, bot }) })
    socket.on("message", data => this.handleStreamMessage(entry, data))
    socket.on("error", error => this.log("error", bot.self_id, "Stream 错误", error))
    socket.on("close", () => { const current = this.managedAccounts.get(accountId); if (current?.socket !== socket) return; this.managedAccounts.delete(accountId); this.log("warn", bot.self_id, "Stream 已断开"); if (account.autoReconnect !== false) this.scheduleReconnect(account) })
  }
  scheduleReconnect(account) {
    const accountId = String(account.accountId || account.clientId || "default"), old = this.managedAccounts.get(accountId)
    if (old?.timer) return
    const timer = setTimeout(() => { const entry = this.managedAccounts.get(accountId); if (entry) delete entry.timer; this.startAccount(account).catch(error => this.log("error", accountId, error)) }, Math.max(1000, Number(account.reconnectInterval || 10) * 1000))
    this.managedAccounts.set(accountId, { ...(old || {}), config: account, timer })
  }
  makeBot(self_id, account) {
    const old = Bot[self_id] || Bot.bots[self_id]
    if (old?.adapter === this) return old
    const bot = { adapter: this, self_id, uin: self_id, dingtalk_id: account.platformId, nickname: account.botName || `DingTalkBot (${account.accountId})`, avatar: account.botAvatar, version: { id: self_id, name: this.name, version: this.version }, stat: { start_time: Date.now() / 1000 }, fl: new Map(), gl: new Map(), gml: new Map() }
    bot.pickFriend = user_id => this.pickFriend(bot, user_id); bot.pickUser = bot.pickFriend; bot.pickGroup = group_id => this.pickGroup(bot, group_id); bot.pickMember = (group_id, user_id) => this.pickMember(bot, group_id, user_id)
    bot.getFriendList = async () => bot.fl; bot.getGroupList = async () => bot.gl
    Bot[self_id] = bot; Bot.bots[self_id] = bot; if (!Bot.uin.includes(self_id)) Bot.uin.push(self_id); return bot
  }
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
    user_id = String(user_id); const info = { ...(bot.fl.get(user_id) || {}), user_id, self_id: bot.self_id, ...context }
    return { ...info, sendMsg: message => this.sendMessage(bot, info, message), sendFile: (file, name) => this.sendMessage(bot, info, [{ type: "file", file, name }]), getInfo: async () => info }
  }
  pickMember(bot, group_id, user_id) { return { ...this.pickFriend(bot, user_id), group_id: String(group_id), user_id: String(user_id) } }
  pickGroup(bot, group_id, context = {}) {
    group_id = String(group_id); const info = { ...(bot.gl.get(group_id) || {}), group_id, self_id: bot.self_id, ...context }
    return { ...info, sendMsg: message => this.sendMessage(bot, info, message), sendFile: (file, name) => this.sendMessage(bot, info, [{ type: "file", file, name }]), pickMember: user_id => this.pickMember(bot, group_id, user_id), getInfo: async () => info }
  }
  async renderMessage(message) {
    const out = []
    for (let segment of Array.isArray(message) ? message : [message]) {
      if (segment === null || segment === undefined) continue
      if (typeof segment !== "object") segment = { type: "text", text: String(segment) }
      if (!segment.data) segment = { ...segment, data: segment }
      const data = segment.data || segment
      switch (segment.type) {
        case "text": out.push(data.text || data.content || ""); break
        case "at": out.push(`@${data.qq === "all" ? "所有人" : data.qq} `); break
        case "reply": out.push(`> 回复 ${data.id || ""}\n`); break
        case "image": {
          const file = await Bot.fileType(data, { http: true })
          let url
          if (typeof Bot.imageToUrl === "function") {
            try { url = await Bot.imageToUrl(file, { name: file.name }) }
            catch (error) { this.log("warn", null, "图床上传失败，改用本地图片地址", error) }
          }
          url ||= await Bot.fileToUrl(file)
          out.push(`![${data.summary || "图片"}](${url})`)
          break
        }
        case "file": { const file = await Bot.fileType(data, { http: true }); out.push(`[${data.name || file.name || "文件"}](${await Bot.fileToUrl(file)})`); break }
        case "node": for (const node of data || []) out.push(await this.renderMessage(node.message || node)); break
        case "button": break
        default: out.push(data.text || Bot.String(segment))
      }
    }
    return out.join("")
  }
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
            if (button?.text && /^https?:\/\//i.test(link || "")) buttons.push({ title: String(button.text), actionURL: link })
          }
        }
      } else if (item.type === "node") {
        for (const node of data || []) visit(node.message || node)
      }
    }
    visit(message)
    return buttons
  }
  async sendMessage(bot, data, message) {
    const text = (await this.renderMessage(message)).trim(), buttons = this.getActionButtons(message)
    if (!text && !buttons.length) return false
    const entry = [...this.managedAccounts.values()].find(item => item.bot === bot), webhook = data.sessionWebhook || entry?.config?.webhook
    if (!webhook) { this.log("error", bot.self_id, "消息缺少 sessionWebhook，且账号未配置 webhook"); return false }
    if (buttons.length > 5) this.log("warn", bot.self_id, `钉钉 ActionCard 最多支持 5 个跳转按钮，已截取前 5 个`)
    const cardButtons = buttons.slice(0, 5)
    const payload = cardButtons.length
      ? { msgtype: "actionCard", actionCard: { title: bot.nickname || "DingTalk", text: text || " ", btnOrientation: "0", btns: cardButtons } }
      : { msgtype: "markdown", markdown: { title: bot.nickname || "DingTalk", text } }
    const response = await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }), result = await response.json().catch(() => ({}))
    if (!response.ok || result.errcode) throw new Error(`DingTalk 发送失败: ${Bot.String(result)}`)
    const target = data.group_id ? `群消息：[${data.group_id}]` : `好友消息：[${data.user_id || "unknown"}]`
    Bot.makeLog("info", [target, text || "[ActionCard]"], bot.self_id)
    bot.stat.message_sent = (bot.stat.message_sent || 0) + 1; return { message_id: `${bot.self_id}_${Date.now().toString(36)}` }
  }
  async decode(body, bot, account) {
    const user_id = String(body.senderStaffId || body.senderId || "unknown"), isGroup = String(body.conversationType) === "2", text = String(body.text?.content || "").trim(), message = text ? [{ type: "text", text }] : []
    let userInfo = {}
    if (user_id !== "unknown") {
      try { userInfo = await this.getUserInfo(account, user_id) }
      catch (error) {
        const errorKey = `${account.accountId || account.clientId}:${user_id}`
        if (!this.userInfoErrors.has(errorKey)) { this.userInfoErrors.add(errorKey); this.log("warn", bot.self_id, "获取用户头像/昵称失败，已使用消息事件信息", error) }
      }
    }
    const botAtIds = new Set([body.chatbotUserId, body.robotCode, account.robotCode, account.chatbotUserId].filter(Boolean).map(String))
    let botAt = false
    for (const at of body.atUsers || []) {
      const candidates = [at.staffId, at.dingtalkId].filter(Boolean).map(String)
      const id = candidates[0]
      if (!id) continue
      if (candidates.some(candidate => botAtIds.has(candidate))) {
        botAt = true
        message.unshift({ type: "at", qq: bot.self_id })
      } else message.unshift({ type: "at", qq: String(id) })
    }
    // Some DingTalk events only expose isInAtList and omit the robot ID.
    if (body.isInAtList && !botAt) message.unshift({ type: "at", qq: bot.self_id })
    if (body.msgtype === "picture" && body.content?.downloadCode) { const url = await this.downloadFile(account, body.content.downloadCode); message.push({ type: "image", url, file: url }) }
    if (body.msgtype === "file" && body.content?.downloadCode) { const url = await this.downloadFile(account, body.content.downloadCode); message.push({ type: "file", url, file: url, name: body.content.fileName }) }
    if (body.msgtype === "richText") for (const item of body.content?.richText || []) { if (item.text) message.push({ type: "text", text: item.text }); const code = item.downloadCode || item.pictureDownloadCode; if (code) { const url = await this.downloadFile(account, code); message.push({ type: "image", url, file: url }) } }
    if (!message.length) return null
    const nickname = body.senderNick || userInfo.name || userInfo.nickname || user_id
    const sender = { user_id, nickname, avatar: body.senderAvatar || userInfo.avatar || "", card: nickname, role: body.isAdmin ? "admin" : "member" }
    bot.fl.set(user_id, sender)
    const data = { bot, adapter_id: this.id, adapter_name: this.name, post_type: "message", message_type: isGroup ? "group" : "private", sub_type: "normal", self_id: bot.self_id, user_id, message_id: String(body.msgId || Date.now()), raw_message: text, message, sender, nickname, avatar: sender.avatar, time: Math.floor(Number(body.createAt || Date.now()) / 1000), sessionWebhook: body.sessionWebhook, conversationId: body.conversationId, dingtalk_event: body, atme: botAt || Boolean(body.isInAtList) }
    if (isGroup) { data.group_id = String(body.conversationId); data.group_name = body.conversationTitle || "DingTalk 群聊"; data.group = this.pickGroup(bot, data.group_id, data) } else data.friend = this.pickFriend(bot, user_id, data)
    return data
  }
  handleStreamMessage(entry, raw) {
    Promise.resolve().then(async () => { const envelope = JSON.parse(raw.toString()); if (envelope.type === "SYSTEM" && envelope.headers?.topic === "ping") return entry.socket.send(JSON.stringify({ code: 200, headers: envelope.headers, message: "OK", data: envelope.data })); if (envelope.type !== "CALLBACK") return; const body = typeof envelope.data === "string" ? JSON.parse(envelope.data) : envelope.data; this.bindPlatformId(entry, body.chatbotUserId); await this.updateBotProfile(entry, body); const data = await this.decode(body, entry.bot, entry.config); if (data) { entry.bot.stat.message_received = (entry.bot.stat.message_received || 0) + 1; this.log("info", entry.bot.self_id, `${data.message_type === "group" ? "群" : "私聊"}消息：${data.raw_message}`); Bot.em(`message.${data.message_type}`, data) } if (envelope.headers?.messageId) entry.socket.send(JSON.stringify({ code: 200, headers: { ...envelope.headers, content_type: "application/json" }, message: "OK", data: JSON.stringify({ status: "SUCCESS", message: "OK" }) })) }).catch(error => this.log("error", entry.bot.self_id, "Stream 消息处理失败", error))
  }
}

const adapter = new DingTalkAdapter()
Bot.adapter.push(adapter)

export class DingTalkPlugin extends plugin {
  constructor() {
    super({
      name: "DingTalk",
      dsc: "DingTalk 钉钉机器人适配器设置",
      event: "message",
      priority: -1000,
      rule: [
        { reg: "^#?DingTalk账号$", fnc: "list", permission: config.permission },
        { reg: "^#?DingTalk设置", fnc: "set", permission: config.permission },
        { reg: "^#?DingTalk重载$", fnc: "reload", permission: config.permission },
      ],
    })
  }

  async list() {
    const accounts = Array.isArray(config.dingdingAccounts) ? config.dingdingAccounts : []
    if (!accounts.length) return this.reply("当前没有配置 DingTalk 账号", true)
    const text = accounts.map((item, index) => {
      const status = adapter.managedAccounts.get(item.accountId)?.bot ? "已注册" : "未连接"
      return `${index + 1}. ${item.accountId || "未命名"} (${item.clientId || "未配置 AppKey"}) - ${status}`
    }).join("\n")
    return this.reply(`DingTalk 账号：\n${text}`, true)
  }

  async set() {
    const value = this.e.msg.replace(/^#?DingTalk设置/, "").trim()
    if (!value) return this.reply("格式：#DingTalk设置账号标识:AppKey:AppSecret[:默认Webhook]", true)
    const parts = value.split(":")
    const accountId = parts.shift()
    const clientId = parts.shift()
    const clientSecret = parts.shift()
    const webhook = parts.join(":")
    if (!accountId || !clientId || !clientSecret) return this.reply("格式：#DingTalk设置账号标识:AppKey:AppSecret[:默认Webhook]", true)
    const accounts = Array.isArray(config.dingdingAccounts) ? config.dingdingAccounts : []
    const old = accounts.find(item => item.accountId === accountId)
    const account = { ...(old || {}), accountId, clientId, clientSecret, webhook, autoReconnect: old?.autoReconnect !== false }
    const index = accounts.findIndex(item => item.accountId === accountId)
    if (index === -1) accounts.push(account)
    else accounts[index] = account
    await configSave()
    if (!adapter.managedAccounts.get(accountId)?.bot) {
      await adapter.startAccount(account).catch(error => this.reply(`账号 ${accountId} 连接失败：${error.message}`, true))
    }
    return this.reply(`账号 ${accountId} 已保存并尝试连接。`, true)
  }

  async reload() {
    await configSave()
    return this.reply("DingTalk 配置已保存；连接会在下次重启时按新配置建立。", true)
  }
}

logger.info(logger.green("- DingTalk 适配器插件 加载完成"))

