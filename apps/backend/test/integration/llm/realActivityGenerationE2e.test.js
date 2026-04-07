const {
  registerRealActivityGenerationAllProvidersE2e,
  registerRealActivityGenerationAutoFallbackE2e,
} = require("./realActivityGenerationE2e.shared");

registerRealActivityGenerationAllProvidersE2e({
  defaultLanguages: ["java"],
  defaultCounts: ["1"],
  defaultStyles: ["stdout"],
});

registerRealActivityGenerationAutoFallbackE2e({
  defaultLanguages: ["java"],
  defaultCounts: ["1"],
  defaultStyles: ["stdout"],
});
