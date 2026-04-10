const path = require("node:path");

function loadDotenvFallbacks() {
  try {
    require("dotenv").config({
      path: path.resolve(__dirname, "../../.env"),
      quiet: true,
    });
  } catch {
    // ignore
  }

  try {
    require("dotenv").config({
      path: path.resolve(__dirname, "../../../../.env"),
      quiet: true,
      override: false,
    });
  } catch {
    // ignore
  }
}

function hasAnyProviderKey() {
  return Boolean(
    process.env.CODEX_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY
  );
}

function loadRealProviderAuth() {
  if (hasAnyProviderKey()) return { source: "env" };
  loadDotenvFallbacks();
  if (hasAnyProviderKey()) return { source: "dotenv" };
  return { source: null };
}

module.exports = { loadRealProviderAuth };
