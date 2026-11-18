import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface LoadedSkill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  dirPath: string;
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw.trim() };

  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim().replace(/^['"]|['"]$/g, "");
    meta[key] = val;
  }
  return { meta, body: match[2]!.trim() };
}

/**
 * Loads `SKILL.md` bundles from a directory (NanoClaw / OpenClaw convention).
 * Drop a folder with `SKILL.md` to extend agent capabilities without modifying runner code.
 */
export function loadSkillsFromDirectory(skillsRoot: string): LoadedSkill[] {
  if (!existsSync(skillsRoot)) return [];
  const entries = readdirSync(skillsRoot);
  const skills: LoadedSkill[] = [];

  for (const entry of entries) {
    const dirPath = join(skillsRoot, entry);
    if (!statSync(dirPath).isDirectory()) continue;
    const skillMdPath = join(dirPath, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;

    const raw = readFileSync(skillMdPath, "utf8");
    const { meta, body } = parseFrontmatter(raw);
    skills.push({
      id: entry,
      name: meta.name || entry,
      description: meta.description || "",
      instructions: body,
      dirPath
    });
  }

  return skills;
}

export function buildSkillsSystemPrompt(skills: readonly LoadedSkill[]): string {
  if (skills.length === 0) return "";
  const sections = skills.map(
    (s) => `## Skill: ${s.name}\n${s.description ? `${s.description}\n\n` : ""}${s.instructions}`
  );
  return `# Loaded Agent Skills\n\n${sections.join("\n\n---\n\n")}`;
}

