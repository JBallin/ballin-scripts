const codexRuntimeConfig = (appVersion = '26.100.123', pluginVersion = appVersion): string => (
  '# Synthetic configuration; no user files are read.\n'
  + 'model = "synthetic-model"\n'
  + 'model_reasoning_effort = "high"\n'
  + '[desktop]\nconversationDetailMode = "STEPS_COMMANDS"\n'
  + '[projects."/synthetic/project"]\ntrust_level = "trusted"\n'
  + '[mcp_servers.custom]\ncommand = "/synthetic/custom-server"\n'
  + '[mcp_servers.node_repl]\n'
  + 'command = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl"\n'
  + 'args = []\n'
  + '[mcp_servers.node_repl.env]\n'
  + 'CODEX_HOME = "/synthetic/codex"\n'
  + 'BROWSER_USE_CODEX_APP_BUILD_FLAVOR = "prod"\n'
  + `BROWSER_USE_CODEX_APP_VERSION = "${appVersion}"\n`
  + `NODE_REPL_TRUSTED_SERVICES = '{"browser":"/synthetic/codex/plugins/cache/openai-bundled/browser/${pluginVersion}/scripts/browser-service.mjs","sky":"@oai/sky/service","custom":"/synthetic/service.mjs"}'\n`
  + 'CUSTOM_SETTING = "preserved"\n'
);

module.exports = { codexRuntimeConfig };
