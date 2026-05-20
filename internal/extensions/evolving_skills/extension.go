package evolving_skills

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"

	"github.com/collinpfeifer/beluga/internal/core/extension"
	"github.com/collinpfeifer/beluga/internal/core/tools"
)

// Extension manages file-based skills in .beluga/skills/.
// Each skill is a folder with a SKILL.md (knowledge content) and an optional
// prompt.md (injected into the system prompt when the skill is relevant).
type Extension struct {
	skillsDir string
	promptDir string
	logger    *slog.Logger
}

func (e *Extension) Name() string { return "evolving_skills" }

func (e *Extension) Init(ctx extension.ExtensionContext) error {
	e.skillsDir = filepath.Join(filepath.Dir(ctx.PromptDir), "skills")
	e.promptDir = ctx.PromptDir
	e.logger = ctx.Logger

	// Ensure skills directory exists.
	if err := os.MkdirAll(e.skillsDir, 0o755); err != nil {
		return fmt.Errorf("creating skills directory: %w", err)
	}

	// Write a prompt template that tells the agent to search skills
	// when facing unfamiliar problems and create skills at session end.
	promptPath := filepath.Join(e.promptDir, "evolving_skills.md")
	if _, err := os.Stat(promptPath); os.IsNotExist(err) {
		promptContent := `When you encounter an unfamiliar problem, search your skills using skill_search before attempting a solution. At the end of each session, if you learned something new or solved a non-trivial problem, create a skill using skill_create so future sessions can benefit from your experience.`
		if err := os.WriteFile(promptPath, []byte(promptContent), 0o644); err != nil {
			return fmt.Errorf("writing evolving_skills prompt: %w", err)
		}
	}

	// Register tools.
	if err := ctx.Registry.Register(&SkillSearchTool{
		skillsDir: e.skillsDir,
		logger:    e.logger,
	}); err != nil {
		return fmt.Errorf("registering skill_search: %w", err)
	}

	if err := ctx.Registry.Register(&SkillCreateTool{
		skillsDir: e.skillsDir,
		logger:    e.logger,
	}); err != nil {
		return fmt.Errorf("registering skill_create: %w", err)
	}

	e.logger.Info("evolving_skills extension initialized", "skills_dir", e.skillsDir)
	return nil
}

func (e *Extension) Start(ctx context.Context) error {
	<-ctx.Done()
	return nil
}

func (e *Extension) Stop(ctx context.Context) error { return nil }

// sanitizeName converts a skill name to a safe directory name:
// lowercase, spaces to dashes, alphanumeric + dashes only.
var nonAlphaNum = regexp.MustCompile(`[^a-z0-9\-]`)
var multiDash = regexp.MustCompile(`-{2,}`)

func sanitizeName(name string) string {
	s := filepath.Base(name)
	s = regexp.MustCompile(`\s+`).ReplaceAllString(s, "-")
	s = nonAlphaNum.ReplaceAllString(s, "")
	s = multiDash.ReplaceAllString(s, "-")
	return s
}

// Compile-time check.
var _ extension.Extension = (*Extension)(nil)
var _ tools.Tool = (*SkillSearchTool)(nil)
var _ tools.Tool = (*SkillCreateTool)(nil)
