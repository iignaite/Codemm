const driver = require("../ollamaRuntimeDriver");
const { createRuntimePlugin } = require("./RuntimePlugin");

const localRuntimePlugin = createRuntimePlugin({
  id: "ollama-local-runtime",
  provider: "ollama",
  defaultBaseURL: driver.OLLAMA_DEFAULT_URL,
  driver,
});

module.exports = {
  localRuntimePlugin,
  LOCAL_RUNTIME_DEFAULT_URL: localRuntimePlugin.defaultBaseURL,
};
