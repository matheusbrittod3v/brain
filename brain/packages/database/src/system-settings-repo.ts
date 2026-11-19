import { and, asc, eq, sql } from "drizzle-orm";
import type { BrainDb } from "./client.js";
import { systemSettings } from "./schema.js";

export type SystemSettingCategory = "embeddings" | "smtp" | "github" | "runner" | "policies" | "general";

export interface SystemSettingRecord {
  tenantId: string;
  category: string;
  key: string;
  value: unknown;
  isSecret: boolean;
  updatedBy: string;
  updatedAt: Date;
}

/**
 * Persists modular system configuration (Ollama/embeddings, SMTP, GitHub, runner defaults, policies)
 * in PostgreSQL instead of bloating `.env`.
 */
export class PgSystemSettingsRepository {
  private ensured = false;
  private seeded = false;

  constructor(private readonly db: BrainDb) {}

  async ensureTable(): Promise<void> {
    if (this.ensured) return;
    try {
      const check = await this.db.execute(sql`SELECT to_regclass('public.system_settings') AS tbl`);
      const rows = Array.isArray(check) ? check : (check as { rows?: Array<{ tbl?: string | null }> }).rows ?? [];
      if (rows[0]?.tbl) {
        this.ensured = true;
        return;
      }
      await this.db.execute(sql`
        CREATE TABLE IF NOT EXISTS system_settings (
          tenant_id TEXT NOT NULL DEFAULT 'default-org',
          category TEXT NOT NULL,
          key TEXT NOT NULL,
          value JSONB NOT NULL,
          is_secret BOOLEAN NOT NULL DEFAULT FALSE,
          updated_by TEXT NOT NULL DEFAULT 'system',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (tenant_id, category, key)
        )
      `);
    } catch {
      // May already exist via admin migration
    }
    this.ensured = true;
  }

  async seedDefaultsIfEmpty(tenantId = "default-org"): Promise<void> {
    if (this.seeded) return;
    await this.ensureTable();
    const existing = await this.db
      .select({ key: systemSettings.key })
      .from(systemSettings)
      .where(eq(systemSettings.tenantId, tenantId))
      .limit(1)
      .catch(() => []);
    if (existing.length > 0) {
      this.seeded = true;
      return;
    }

    const defaults: Array<{ category: SystemSettingCategory; key: string; value: unknown; isSecret?: boolean }> = [
      { category: "embeddings", key: "provider", value: "ollama" },
      { category: "embeddings", key: "ollama_base_url", value: process.env.OLLAMA_BASE_URL || "http://localhost:11434" },
      { category: "embeddings", key: "embedding_model", value: process.env.EMBEDDING_MODEL || "bge-m3" },
      { category: "runner", key: "execution_mode", value: process.env.BRAIN_RUNNER_MODEL_EXECUTION || "ollama" },
      { category: "runner", key: "default_model", value: process.env.RUNNER_MODEL || "gemma:2b-instruct-q2_K" },
      { category: "policies", key: "default_policies", value: ["public-org", "internal-project"] },
      { category: "policies", key: "audit_policy_id", value: process.env.BRAIN_AUDIT_POLICY_ID || "internal-project" },
      { category: "smtp", key: "host", value: process.env.SMTP_HOST || "" },
      { category: "smtp", key: "port", value: Number(process.env.SMTP_PORT || 587) },
      { category: "smtp", key: "user", value: process.env.SMTP_USER || "" },
      { category: "smtp", key: "pass", value: process.env.SMTP_PASS || "", isSecret: true },
      { category: "smtp", key: "from", value: process.env.SMTP_FROM || "no-reply@brain.local" },
      { category: "smtp", key: "secure", value: process.env.SMTP_SECURE === "true" },
      { category: "github", key: "token", value: process.env.GITHUB_TOKEN || "", isSecret: true },
      { category: "github", key: "webhook_secret", value: process.env.GITHUB_WEBHOOK_SECRET || "", isSecret: true },
      {
        category: "github",
        key: "repo_map",
        value: (() => {
          try {
            return process.env.BRAIN_GITHUB_REPO_MAP_JSON ? JSON.parse(process.env.BRAIN_GITHUB_REPO_MAP_JSON) : {};
          } catch {
            return {};
          }
        })()
      }
    ];

    for (const item of defaults) {
      await this.upsertSetting(tenantId, item.category, item.key, item.value, Boolean(item.isSecret), "bootstrap");
    }
    this.seeded = true;
  }

  async listSettings(tenantId = "default-org", category?: string, maskSecrets = true): Promise<SystemSettingRecord[]> {
    await this.seedDefaultsIfEmpty(tenantId);
    const rows = await this.db
      .select()
      .from(systemSettings)
      .where(
        category
          ? and(eq(systemSettings.tenantId, tenantId), eq(systemSettings.category, category))
          : eq(systemSettings.tenantId, tenantId)
      )
      .orderBy(asc(systemSettings.category), asc(systemSettings.key));

    return rows.map((row) => ({
      ...row,
      value: maskSecrets && row.isSecret && typeof row.value === "string" && row.value.length > 0 ? "••••••••" : row.value
    }));
  }

  async getSetting<T = unknown>(tenantId: string, category: string, key: string, fallback: T): Promise<T> {
    await this.seedDefaultsIfEmpty(tenantId);
    const rows = await this.db
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(and(eq(systemSettings.tenantId, tenantId), eq(systemSettings.category, category), eq(systemSettings.key, key)))
      .limit(1);
    return (rows[0]?.value as T | undefined) ?? fallback;
  }

  async upsertSetting(
    tenantId: string,
    category: string,
    key: string,
    value: unknown,
    isSecret = false,
    updatedBy = "system"
  ): Promise<SystemSettingRecord> {
    await this.ensureTable();
    const [row] = await this.db
      .insert(systemSettings)
      .values({ tenantId, category, key, value, isSecret, updatedBy, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [systemSettings.tenantId, systemSettings.category, systemSettings.key],
        set: { value, isSecret, updatedBy, updatedAt: new Date() }
      })
      .returning();
    return row!;
  }

  async deleteSetting(tenantId: string, category: string, key: string): Promise<boolean> {
    await this.ensureTable();
    const deleted = await this.db
      .delete(systemSettings)
      .where(and(eq(systemSettings.tenantId, tenantId), eq(systemSettings.category, category), eq(systemSettings.key, key)))
      .returning({ key: systemSettings.key });
    return deleted.length > 0;
  }
}
