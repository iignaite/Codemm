const MODEL_PROFILES = [
  {
    id: "coder-small",
    model: "qwen2.5-coder:1.5b",
    minRamGb: 6,
    preferredDiskGb: 4,
    priority: 1,
    preferredUseCases: ["dialogue", "general"],
  },
  {
    id: "coder-balanced",
    model: "qwen2.5-coder:7b",
    minRamGb: 12,
    preferredDiskGb: 8,
    priority: 2,
    preferredUseCases: ["general", "edit"],
  },
  {
    id: "coder-large",
    model: "qwen2.5-coder:14b",
    minRamGb: 24,
    preferredDiskGb: 16,
    priority: 3,
    preferredUseCases: ["generation", "edit"],
  },
];

function sortProfiles(caps, useCase) {
  return [...MODEL_PROFILES].sort((a, b) => {
    const aScore = scoreProfile(a, caps, useCase);
    const bScore = scoreProfile(b, caps, useCase);
    return bScore - aScore;
  });
}

function scoreProfile(profile, caps, useCase) {
  let score = profile.priority * 100;
  if (caps.totalRamGb >= profile.minRamGb) score += 50;
  if (caps.diskFreeGb == null || caps.diskFreeGb >= profile.preferredDiskGb) score += 25;
  if (caps.gpu && caps.gpu.available) score += 10;
  if (Array.isArray(profile.preferredUseCases) && profile.preferredUseCases.includes(useCase || "general")) score += 20;
  if (caps.totalRamGb < profile.minRamGb) score -= (profile.minRamGb - caps.totalRamGb) * 20;
  return score;
}

function resolveCandidateProfiles(caps, opts = {}) {
  const forcedModel = typeof opts.forcedModel === "string" && opts.forcedModel.trim() ? opts.forcedModel.trim() : null;
  const useCase = typeof opts.useCase === "string" && opts.useCase.trim() ? opts.useCase.trim() : "general";
  if (forcedModel) {
    return [{ id: "forced", model: forcedModel, minRamGb: 0, preferredDiskGb: 0, priority: 999 }];
  }

  const ranked = sortProfiles(caps, useCase);
  const compatible = ranked.filter((profile) => {
    if (caps.totalRamGb < profile.minRamGb) return false;
    if (typeof caps.diskFreeGb === "number" && caps.diskFreeGb < profile.preferredDiskGb) return false;
    return true;
  });

  if (compatible.length > 0) return compatible;
  return ranked.reverse();
}

module.exports = {
  MODEL_PROFILES,
  resolveCandidateProfiles,
};
