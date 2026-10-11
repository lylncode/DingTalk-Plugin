import makeConfig from "../../lib/plugins/config.js"
import path from "path"
import { fileURLToPath } from "url"

// 插件根目录（guoba 图标用本地文件时需绝对路径）
const pluginRoot = path.dirname(fileURLToPath(import.meta.url))

const { config, configSave } = await makeConfig("DingTalk", {
  markdown: true,
  cardTemplateId: "",
  uploadStrategy: "public-url",
  dingdingAccounts: [],
  permission: "master",
})

export function supportGuoba() {
  return { pluginInfo: { name: "DingTalk", title: "DingTalk 钉钉适配器", author: ["TRSS-Yunzai"], isV3: true, isV2: false, showInMenu: true, description: "独立的钉钉 Stream 机器人适配器，支持多账号。", icon: "mdi:dingtalk", iconColor: "#0080ff", iconPath: path.join(pluginRoot, "logo.ico") }, configInfo: {
    schemas: [{ field: "markdown", label: "全局 Markdown", component: "Switch", tips: "开启后普通文本消息也按 Markdown 发送；保存后自动热重载生效" }, { field: "cardTemplateId", label: "互动卡片模板 ID", component: "Input", tips: "卡片平台发布的模板 ID；配置后带按钮的消息改为互动卡片投放（正文 + 任意数量按钮，按钮回调走 Stream）" }, { field: "cardText", label: "纯文本也走卡片", component: "Switch", tips: "开启后纯文本/Markdown 消息也合并为互动卡片投放；注意钉钉互动卡片不支持撤回，关闭时纯文本走普通消息可撤回" }, { field: "dingdingAccounts", label: "钉钉账号", component: "GSubForm", componentProps: { multiple: true, schemas: [{ field: "accountId", label: "账号标识", component: "Input", required: true }, { field: "botName", label: "机器人名称", component: "Input" }, { field: "botAvatar", label: "机器人头像 URL", component: "Input" }, { field: "clientId", label: "Client ID", component: "Input", required: true }, { field: "clientSecret", label: "Client Secret", component: "InputPassword", required: true }, { field: "autoReconnect", label: "自动重连", component: "Switch" }] } }],
    getConfigData() { return { markdown: config.markdown !== false, cardTemplateId: config.cardTemplateId || "", cardText: config.cardText === true, dingdingAccounts: config.dingdingAccounts || [] } },
    setConfigData(data, { Result }) {
      const oldAccounts = new Map((config.dingdingAccounts || []).map(item => [String(item.accountId), item]))
      if (Array.isArray(data.dingdingAccounts)) {
        data.dingdingAccounts = data.dingdingAccounts.map(item => {
          const old = oldAccounts.get(String(item.accountId))
          return old?.platformId && !item.platformId ? { ...item, platformId: old.platformId } : item
        })
      }
      Object.assign(config, data)
      configSave()
      return Result.ok({}, "钉钉配置已保存，全局配置稍后自动生效；账号增删需重启")
    },
  } }
}

