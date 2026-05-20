package evolving_skills

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/collinpfeifer/beluga/internal/core/tools"
)

// SkillSearchTool searches .beluga/skills/*/SKILL.md using grep.
type SkillSearchTool struct {
	skillsDir string
	logger    *slog.Logger
}

func (t *SkillSearchTool) Definition() tools.ToolDef {
	return tools.ToolDef{
		Name:        "skill_search",
		Description: "Search skills by keyword. Skills are learned patterns from past sessions that help you solve problems.",
		Parameters: json.RawMessage(`{
			"type": "object",
			"properties": {
				"query": {
					"type": "string",
					"description": "Search query - keywords to find relevant skills"
				}
			},
			"required": ["query"]
		}`),
	}
}

type skillResult struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Content     string `json:"content"`
	HasPrompt   bool   `json:"has_prompt"`
}

func (t *SkillSearchTool) Execute(ctx context.Context, args json.RawMessage, tctx tools.ToolContext) (json.RawMessage, error) {
	// Dry-run support.
	if os.Getenv("BELUGA_DRY_RUN") == "true" {
		return json.Marshal([]skillResult{
			{Name: "example-skill", Description: "An example skill", Content: "This is a mock skill result.", HasPrompt: true},
		})
	}

	var input struct {
		Query string `json:"query"`
	}
	if err := json.Unmarshal(args, &input); err != nil {
		return nil, fmt.Errorf("parsing args: %w", err)
	}
	if input.Query == "" {
		return nil, fmt.Errorf("query is required")
	}

	// Use grep to find SKILL.md files matching the query.
	cmd := exec.CommandContext(ctx, "grep", "-r", "-l", "-i", input.Query, t.skillsDir)
	output, err := cmd.Output()
	if err != nil {
		// grep exits with code 1 when no matches — that's fine.
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return json.Marshal([]skillResult{})
		}
		// Other error (grep not found, bad dir, etc.)
		return json.Marshal([]skillResult{})
	}

	// Parse matching files into skill results.
	matches := strings.Split(strings.TrimSpace(string(output)), "\n")
	seen := make(map[string]bool)
	var results []skillResult

	for _, match := range matches {
		if match == "" {
			continue
		}

		// Extract skill name from path: skillsDir/<name>/SKILL.md
		rel, err := filepath.Rel(t.skillsDir, match)
		if err != nil {
			continue
		}
		parts := strings.SplitN(rel, string(filepath.Separator), 2)
		name := parts[0]

		if seen[name] {
			continue
		}
		seen[name] = true

		// Read the SKILL.md content.
		content, err := os.ReadFile(match)
		if err != nil {
			t.logger.Warn("failed to read skill", "path", match, "error", err)
			continue
		}

		// First line is the description (after any leading # comment).
		description := extractDescription(string(content))

		// Check if prompt.md exists.
		promptPath := filepath.Join(t.skillsDir, name, "prompt.md")
		hasPrompt := false
		if _, err := os.Stat(promptPath); err == nil {
			hasPrompt = true
		}

		results = append(results, skillResult{
			Name:        name,
			Description: description,
			Content:     string(content),
			HasPrompt:   hasPrompt,
		})
	}

	if results == nil {
		results = []skillResult{}
	}

	return json.Marshal(results)
}

// extractDescription gets the first meaningful line from SKILL.md as a description.
func extractDescription(content string) string {
	lines := strings.Split(content, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// Skip markdown headings but use their text.
		line = strings.TrimPrefix(line, "#")
		line = strings.TrimSpace(line)
		if line != "" {
			return line
		}
	}
	return ""
}
