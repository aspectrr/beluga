// ── Skill loading tool ─────────────────────────────────────────
// Lets the agent load a full SKILL.md on demand by name.

import { readFile } from "fs/promises";
import { join } from "path";
import type {
	Registry,
	Tool,
	ToolDef,
	ToolContext,
} from "@aspectrr/beluga-sdk";
import type { SkillIndex } from "../agent/runner.js";

export class LoadSkillTool implements Tool {
	private skills: SkillIndex[];

	constructor(skills: SkillIndex[]) {
		this.skills = skills;
	}

	definition(): ToolDef {
		return {
			name: "load_skill",
			description:
				"Load a skill's full instructions by name. Use this when a task matches an available skill. Returns the complete skill content to follow.",
			parameters: {
				type: "object",
				properties: {
					name: {
						type: "string",
						description:
							"Name of the skill to load (must match an available skill name)",
					},
				},
				required: ["name"],
			},
		};
	}

	async execute(
		args: Record<string, unknown>,
		_ctx: ToolContext,
	): Promise<Record<string, unknown>> {
		const name = String(args.name);
		const skill = this.skills.find(
			(s) => s.name.toLowerCase() === name.toLowerCase(),
		);

		if (!skill) {
			const available = this.skills.map((s) => s.name).join(", ");
			return {
				error: `Skill '${name}' not found. Available: ${available}`,
			};
		}

		try {
			const raw = await readFile(join(skill.dir, "SKILL.md"), "utf-8");
			const content = raw.replace(/^---[\s\S]*?---\n*/, "").trim();
			return {
				name: skill.name,
				content,
			};
		} catch (err) {
			return { error: `Failed to load skill '${name}': ${err}` };
		}
	}
}

export function registerSkillTools(
	registry: Registry,
	skills: SkillIndex[],
): void {
	if (skills.length === 0) return;
	registry.register(new LoadSkillTool(skills));
}
