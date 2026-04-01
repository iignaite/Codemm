const fs = require("fs");
const os = require("os");
const { commandExists } = require("./utils");

function bytesToGb(value) {
  return Math.max(0, Math.floor(Number(value || 0) / (1024 ** 3)));
}

function detectGpu() {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { available: true, kind: "metal", vendor: "apple" };
  }
  if (commandExists("nvidia-smi", ["-L"])) {
    return { available: true, kind: "cuda", vendor: "nvidia" };
  }
  return { available: false, kind: null, vendor: null };
}

function getDiskFreeGb(dirPath) {
  try {
    if (typeof fs.statfsSync !== "function") return null;
    const out = fs.statfsSync(dirPath);
    const free = Number(out.bavail || out.bfree || 0) * Number(out.bsize || 0);
    return bytesToGb(free);
  } catch {
    return null;
  }
}

function probeHostCapabilities({ probePath }) {
  const totalRamGb = bytesToGb(os.totalmem());
  const freeRamGb = bytesToGb(os.freemem());
  const cpuCount = Array.isArray(os.cpus()) ? os.cpus().length : 0;
  const gpu = detectGpu();
  const diskFreeGb = getDiskFreeGb(probePath || os.homedir());

  return {
    platform: process.platform,
    arch: process.arch,
    totalRamGb,
    freeRamGb,
    cpuCount,
    gpu,
    diskFreeGb,
  };
}

module.exports = {
  probeHostCapabilities,
};
