package evolving_skills

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/collinpfeifer/beluga/internal/core/tools"
)

// SkillCreateTool creates a new skill folder with SKILL.md and prompt.md.
type SkillCreateTool struct {
	skillsDir string
	logger    *slog.Logger
}

func (t *SkillCreateTool) Definition() tools.ToolDef {
	return tools.ToolDef{
		Name:        "skill_create",
		Description: "Create a new skill from learned knowledge. The skill will be available for future sessions.",
		Parameters: json.RawMessage(`{
			"type": "object",
			"properties": {
				"name": {
					"type": "string",
					"description": "Short kebab-case name for the skill (e.g. 'kafka-debugging')"
				},
				"description": {
					"type": "string",
					"description": "Brief description of when to use this skill"
				},
				"content": {
					"type": "string",
					"description": "The full knowledge content in markdown"
				}
			},
			"required": ["name", "description", "content"]
		}`),
	}
}

func (t *SkillCreateTool) Execute(ctx context.Context, args json.RawMessage, tctx tools.ToolContext) (json.RawMessage, error) {
	// Dry-run support.
	if os.Getenv("BELUGA_DRY_RUN") == "true" {
		return json.Marshal(map[string]string{
			"status": "created",
			"path":   filepath.Join(t.skillsDir, "mock-skill"),
		})
	}

	var input struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Content     string `json:"content"`
	}
	if err := json.Unmarshal(args, &input); err != nil {
		return nil, fmt.Errorf("parsing args: %w", err)
	}
	if input.Name == "" {
		return nil, fmt.Errorf("name is required")
	}
	if input.Content == "" {
		return nil, fmt.Errorf("content is required")
	}

	// Sanitize the name.
	name := sanitizeName(input.Name)
	if name == "" {
		return nil, fmt.Errorf("invalid skill name after sanitization")
	}

	// Create the skill directory.
	skillDir := filepath.Join(t.skillsDir, name)
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		return nil, fmt.Errorf("creating skill directory: %w", err)
	}

	// Check if skill already exists.
	skillPath := filepath.Join(skillDir, "SKILL.md")
	if _, err := os.Stat(skillPath); err == nil {
		return nil, fmt.Errorf("skill %q already exists", name)
	}

	// Write SKILL.md: description as first line (heading), then content.
	var sb strings.Builder
	fmt.Fprintf(&sb, "# %s\n\n", input.Description)
	sb.WriteString(strings.TrimSpace(input.Content))
	sb.WriteString("\n")

	if err := os.WriteFile(skillPath, []byte(sb.String()), 0o644); err != nil {
		return nil, fmt.Errorf("writing SKILL.md: %w", err)
	}

	// Write prompt.md with a brief instruction for when this skill is relevant.
	promptContent := fmt.Sprintf("When dealing with %s, refer to the %s skill for guidance.",
		strings.ToLower(input.Description), name)
	promptPath := filepath.Join(skillDir, "prompt.md")
	if err := os.WriteFile(promptPath, []byte(promptContent), 0o644); err != nil {
		t.logger.Warn("failed to write skill prompt.md", "path", promptPath, "error", err)
		// Non-fatal — the skill still works without prompt.md.
	}

	t.logger.Info("skill created", "name", name, "path", skillDir)

	return json.Marshal(map[string]string{
		"status": "created",
		"path":   skillDir,
	})
}
