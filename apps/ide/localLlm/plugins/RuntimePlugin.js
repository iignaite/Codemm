function createRuntimePlugin(definition) {
  if (!definition || typeof definition !== "object") {
    throw new Error("Runtime plugin definition is required.");
  }
  if (typeof definition.id !== "string" || !definition.id.trim()) {
    throw new Error("Runtime plugin id is required.");
  }
  if (!definition.driver || typeof definition.driver !== "object") {
    throw new Error(`Runtime plugin "${definition.id}" must provide a driver.`);
  }
  return Object.freeze({ ...definition, id: definition.id.trim() });
}

module.exports = { createRuntimePlugin };
