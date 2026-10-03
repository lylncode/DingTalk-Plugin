import makeConfig from "../../../lib/plugins/config.js"

const defaults = {
  enableDingAdapter: true,
  debugGlobal: false,
  uploadStrategy: "public-url",
  dingdingAccounts: [],
  permission: "master",
}

const { config, configSave, configFile } = await makeConfig("DingTalk", defaults)

export { configSave, configFile }
export default config

