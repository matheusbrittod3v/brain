import type { MemoryEntry } from "./index.js";

export interface MemoryDecayConfig {
  /** Base half-life in hours (default 168h = 7 days, adapted from MemoryJS DecayEngine). */
  halfLifeHours?: number;
  /** Minimum importance floor (default 0.05). */
  minImportance?: number;
  /** Weight boost per access hit (default 0.08). */
  accessBoostFactor?: number;
}

export interface ScoredMemoryEntry {
  entry: MemoryEntry;
  effectiveImportance: number;
  decayFactor: number;
  ageHours: number;
}

/**
 * Computes time-based exponential memory decay modulated by access frequency (`hitCount`)
 * and approval/confidence status (adapted from MemoryJS `DecayEngine`).
 */
export function computeEffectiveImportance(
  entry: MemoryEntry,
  now = new Date(),
  config: MemoryDecayConfig = {}
): ScoredMemoryEntry {
  const halfLifeHours = config.halfLifeHours ?? 168;
  const minImportance = config.minImportance ?? 0.05;
  const accessBoostFactor = config.accessBoostFactor ?? 0.08;

  const createdMs = Date.parse(entry.createdAt);
  const ageHours = Number.isFinite(createdMs) ? Math.max(0, (now.getTime() - createdMs) / 3_600_000) : 0;

  // Approved / organizational memories decay 4x slower than raw working drafts.
  const layerMultiplier =
    entry.status === "approved" || entry.layer === "organizational" || entry.layer === "procedural" ? 4 : 1;
  const accessModulation = 1 + Math.log1p(Math.max(0, entry.hitCount)) * accessBoostFactor * 10;
  const effectiveHalfLife = halfLifeHours * layerMultiplier * accessModulation;

  const decayFactor = Math.pow(0.5, ageHours / Math.max(1, effectiveHalfLife));
  const baseImportance = Math.max(minImportance, Math.min(1, entry.confidence));
  const effectiveImportance = Math.max(minImportance, Number((baseImportance * decayFactor).toFixed(4)));

  return {
    entry,
    effectiveImportance,
    decayFactor: Number(decayFactor.toFixed(4)),
    ageHours: Number(ageHours.toFixed(2))
  };
}

export function rankMemoriesWithDecay(
  entries: readonly MemoryEntry[],
  now = new Date(),
  config: MemoryDecayConfig = {}
): ScoredMemoryEntry[] {
  return entries
    .map((entry) => computeEffectiveImportance(entry, now, config))
    .sort((a, b) => b.effectiveImportance - a.effectiveImportance);
}

export function findWeakMemoriesForPruning(
  entries: readonly MemoryEntry[],
  threshold = 0.15,
  now = new Date(),
  config: MemoryDecayConfig = {}
): ScoredMemoryEntry[] {
  return entries
    .filter((e) => e.status !== "approved")
    .map((entry) => computeEffectiveImportance(entry, now, config))
    .filter((scored) => scored.effectiveImportance < threshold);
}

