import os from "node:os";

export type HardwareTier = "high" | "mid" | "low";

export interface HardwareOptimizationProfile {
  tier: HardwareTier;
  name: string;
  label: string;
  totalMemoryMB: number;
  freeMemoryMB: number;
  localBudgetMB: number;
  platform: NodeJS.Platform;
  arch: string;
  cpu: string;
  cores: number;
  unifiedMemory: boolean;
  maxConcurrentHeavy: number;
  maxConcurrentLight: number;
  contextWindow: number;
  threadCount: number;
  allowMetalOffload: boolean;
  restrictHeavyLocalModels: boolean;
  recommendedModelClass: "cloud-or-3b" | "8b-or-smaller" | "local-models";
}

function profileHost(): HardwareOptimizationProfile {
  const totalMemoryMB = Math.round(os.totalmem() / 1024 ** 2);
  const freeMemoryMB = Math.round(os.freemem() / 1024 ** 2);
  const platform = os.platform();
  const arch = os.arch();
  const cores = Math.max(1, os.cpus().length);
  const cpu = os.cpus()[0]?.model ?? (platform === "darwin" && arch === "arm64" ? "Apple Silicon" : "Unknown CPU");
  const unifiedMemory = platform === "darwin" && arch === "arm64";
  const tier: HardwareTier = totalMemoryMB >= 48 * 1024 ? "high" : totalMemoryMB >= 16 * 1024 ? "mid" : "low";
  const label = unifiedMemory && tier === "high"
    ? `${cpu.includes("Apple") ? cpu : "Apple Silicon"} Optimized`
    : tier === "high"
      ? "High-Memory Host Optimized"
      : tier === "mid"
        ? "Mid-Range Host Optimized"
        : "Low-Memory Host Protected";

  const limits = tier === "high"
    ? { maxConcurrentHeavy: 1, maxConcurrentLight: 2, contextWindow: 16_384, recommendedModelClass: "local-models" as const }
    : tier === "mid"
      ? { maxConcurrentHeavy: 1, maxConcurrentLight: 1, contextWindow: 8_192, recommendedModelClass: "8b-or-smaller" as const }
      : { maxConcurrentHeavy: 0, maxConcurrentLight: 1, contextWindow: 4_096, recommendedModelClass: "cloud-or-3b" as const };

  return {
    tier,
    name: tier === "high" ? "High Memory" : tier === "mid" ? "Balanced" : "Memory Saver",
    label,
    totalMemoryMB,
    freeMemoryMB,
    localBudgetMB: Math.max(1_024, totalMemoryMB - (tier === "high" ? 8_192 : tier === "mid" ? 6_144 : 4_096)),
    platform,
    arch,
    cpu,
    cores,
    unifiedMemory,
    ...limits,
    threadCount: Math.max(1, Math.min(cores, tier === "high" ? 8 : tier === "mid" ? 6 : 4)),
    allowMetalOffload: unifiedMemory,
    restrictHeavyLocalModels: tier === "low",
  };
}

// Module initialization runs once per Node.js worker and captures host capabilities
// before the first request is handled. No shell commands or network calls are used.
export const hardwareProfile = profileHost();

export function getHardwareProfile(): HardwareOptimizationProfile {
  return hardwareProfile;
}
