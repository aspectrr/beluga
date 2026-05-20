package extend

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// VerifyResult holds the output of extension verification.
type VerifyResult struct {
	Compiles  bool        `json:"compiles"`
	TestsPass bool        `json:"tests_pass"`
	Tools     []ToolCheck `json:"tools"`
	Errors    []string    `json:"errors"`
}

// ToolCheck holds verification status for a single tool.
type ToolCheck struct {
	Name        string `json:"name"`
	SchemaValid string `json:"schema_valid"` // "passed", "failed", "skipped"
	DryRun      string `json:"dry_run"`      // "passed", "failed", "skipped"
}

// Verify validates an extension at the given path.
// It runs three checks: compile, schema validation (via tests), and dry-run.
// Returns a structured VerifyResult with details.
func Verify(path string) (*VerifyResult, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolving path: %w", err)
	}

	// Check the directory exists.
	if _, err := os.Stat(absPath); os.IsNotExist(err) {
		return nil, fmt.Errorf("extension directory %s does not exist", absPath)
	}

	result := &VerifyResult{
		Tools:  []ToolCheck{},
		Errors: []string{},
	}

	// 1. Compile check.
	result.Compiles = verifyCompile(absPath, result)

	// 2. Schema validation via test.
	result.Tools = verifyTests(absPath, result)

	// 3. Overall tests pass status.
	result.TestsPass = len(result.Errors) == 0 && result.Compiles

	return result, nil
}

// verifyCompile runs `go build ./...` in the extension directory.
// Returns true if it compiles cleanly.
func verifyCompile(dir string, result *VerifyResult) bool {
	cmd := exec.Command("go", "build", "./...")
	cmd.Dir = dir
	cmd.Stdout = nil
	cmd.Stderr = nil

	output, err := cmd.CombinedOutput()
	if err != nil {
		result.Errors = append(result.Errors, fmt.Sprintf("compile: %s", strings.TrimSpace(string(output))))
		return false
	}
	return true
}

// verifyTests runs tool-related tests and returns tool check results.
// It runs:
//   - `go test -run TestToolSchema -v -json ./...` for schema validation
//   - `go test -run TestDryRun -v -json ./...` for dry-run checks
func verifyTests(dir string, result *VerifyResult) []ToolCheck {
	var checks []ToolCheck

	// Run schema validation test.
	schemaResult := runNamedTest(dir, "TestToolSchema", result)
	dryRunResult := runNamedTest(dir, "TestDryRun", result)

	// If we got results from tests, build tool checks.
	// For now we track overall schema/dry-run status since we can't
	// easily extract individual tool names from test output without
	// actually importing the extension code.
	if schemaResult != "" || dryRunResult != "" {
		checks = append(checks, ToolCheck{
			Name:        "(all tools)",
			SchemaValid: schemaResult,
			DryRun:      dryRunResult,
		})
	}

	return checks
}

// runNamedTest runs a specific test by name in the extension directory.
// Returns "passed", "failed", or "skipped".
func runNamedTest(dir string, testName string, result *VerifyResult) string {
	cmd := exec.Command("go", "test", "-run", testName, "-v", "./...")
	cmd.Dir = dir

	output, err := cmd.CombinedOutput()
	if err != nil {
		// Test failed or didn't compile.
		out := strings.TrimSpace(string(output))
		if out != "" {
			result.Errors = append(result.Errors, fmt.Sprintf("%s: %s", testName, out))
		}
		return "failed"
	}

	// Check if the test was actually found and ran.
	outputStr := string(output)
	if strings.Contains(outputStr, "PASS") {
		return "passed"
	}
	if strings.Contains(outputStr, "SKIP") || strings.Contains(outputStr, "testing: warning: no tests to run") {
		return "skipped"
	}

	return "skipped"
}

// PrintVerifyResult writes a human-readable summary to stderr and JSON to stdout.
func PrintVerifyResult(result *VerifyResult) error {
	// JSON to stdout.
	data, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling result: %w", err)
	}
	fmt.Println(string(data))

	// Human summary to stderr.
	fmt.Fprintln(os.Stderr)
	if result.Compiles {
		fmt.Fprintln(os.Stderr, "  ✓ Compiles")
	} else {
		fmt.Fprintln(os.Stderr, "  ✗ Compile failed")
	}

	if result.TestsPass {
		fmt.Fprintln(os.Stderr, "  ✓ Tests pass")
	} else {
		fmt.Fprintln(os.Stderr, "  ✗ Tests failed")
	}

	for _, tc := range result.Tools {
		schemaIcon := iconFor(tc.SchemaValid)
		dryRunIcon := iconFor(tc.DryRun)
		fmt.Fprintf(os.Stderr, "    %s Schema: %s  |  %s Dry-run: %s\n",
			schemaIcon, tc.SchemaValid, dryRunIcon, tc.DryRun)
	}

	if len(result.Errors) > 0 {
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "  Errors:")
		for _, e := range result.Errors {
			fmt.Fprintf(os.Stderr, "    - %s\n", e)
		}
	}

	return nil
}

func iconFor(status string) string {
	switch status {
	case "passed":
		return "✓"
	case "failed":
		return "✗"
	default:
		return "○"
	}
}
