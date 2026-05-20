package extend

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// InstallConfig holds options for installing an extension.
type InstallConfig struct {
	Path      string // path to extension directory
	Type      string // "local" or "remote" (auto-detected if empty)
	BelugaDir string // project root directory (where go.mod lives)
}

// Install installs the extension into the Beluga project.
func Install(cfg InstallConfig) error {
	absPath, err := filepath.Abs(cfg.Path)
	if err != nil {
		return fmt.Errorf("resolving path: %w", err)
	}

	if _, err := os.Stat(absPath); os.IsNotExist(err) {
		return fmt.Errorf("extension directory %s does not exist", absPath)
	}

	// Auto-detect type if not specified.
	if cfg.Type == "" {
		cfg.Type = detectType(absPath)
	}

	// Find the Beluga project root (directory with go.mod).
	if cfg.BelugaDir == "" {
		cfg.BelugaDir = findProjectRoot()
	}
	if cfg.BelugaDir == "" {
		return fmt.Errorf("cannot find Beluga project root (no go.mod found in parent directories)")
	}

	name := filepath.Base(absPath)

	switch cfg.Type {
	case "local":
		return installLocal(absPath, name, cfg.BelugaDir)
	case "remote":
		return installRemote(absPath, name, cfg.BelugaDir)
	default:
		return fmt.Errorf("unknown extension type %q", cfg.Type)
	}
}

// detectType determines whether the extension is local or remote
// based on the files present.
func detectType(dir string) string {
	// If it has extension.go, it's a local extension.
	if _, err := os.Stat(filepath.Join(dir, "extension.go")); err == nil {
		return "local"
	}
	// If it has main.go, it's a remote extension.
	if _, err := os.Stat(filepath.Join(dir, "main.go")); err == nil {
		return "remote"
	}
	return "local" // default
}

// findProjectRoot walks up from cwd looking for a go.mod that contains
// the beluga module path.
func findProjectRoot() string {
	dir, err := os.Getwd()
	if err != nil {
		return ""
	}

	for {
		modPath := filepath.Join(dir, "go.mod")
		data, err := os.ReadFile(modPath)
		if err == nil && strings.Contains(string(data), "github.com/collinpfeifer/beluga") {
			return dir
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return ""
}

// installLocal copies the extension into internal/extensions/{name}/,
// runs go mod tidy, and verifies the project still builds.
func installLocal(srcDir, name, projectRoot string) error {
	extDir := filepath.Join(projectRoot, "internal", "extensions", name)

	// Check if extension already installed.
	if _, err := os.Stat(extDir); err == nil {
		fmt.Fprintf(os.Stderr, "warning: extension directory already exists: %s\n", extDir)
		fmt.Fprintf(os.Stderr, "removing and reinstalling...\n")
		os.RemoveAll(extDir)
	}

	// Create the extensions parent dir if needed.
	if err := os.MkdirAll(filepath.Dir(extDir), 0o755); err != nil {
		return fmt.Errorf("creating extensions directory: %w", err)
	}

	// Copy all .go files from the extension into the target.
	// We copy files (not the directory) to avoid copying the .git or other artifacts.
	entries, err := os.ReadDir(srcDir)
	if err != nil {
		return fmt.Errorf("reading extension directory: %w", err)
	}

	if err := os.MkdirAll(extDir, 0o755); err != nil {
		return fmt.Errorf("creating target directory: %w", err)
	}

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		// Copy Go source files, config, and README.
		ext := strings.ToLower(filepath.Ext(entry.Name()))
		if ext == ".go" || ext == ".yaml" || ext == ".yml" || ext == ".md" {
			src := filepath.Join(srcDir, entry.Name())
			dst := filepath.Join(extDir, entry.Name())
			data, err := os.ReadFile(src)
			if err != nil {
				return fmt.Errorf("reading %s: %w", entry.Name(), err)
			}
			if err := os.WriteFile(dst, data, 0o644); err != nil {
				return fmt.Errorf("writing %s: %w", entry.Name(), err)
			}
		}
	}

	fmt.Fprintf(os.Stderr, "extension copied to %s\n", extDir)

	// Run go mod tidy to pick up any new dependencies.
	tidyCmd := exec.Command("go", "mod", "tidy")
	tidyCmd.Dir = projectRoot
	tidyCmd.Stderr = os.Stderr
	if err := tidyCmd.Run(); err != nil {
		return fmt.Errorf("go mod tidy failed: %w", err)
	}

	// Verify the project still builds.
	buildCmd := exec.Command("go", "build", "./...")
	buildCmd.Dir = projectRoot
	buildCmd.Stderr = os.Stderr
	if err := buildCmd.Run(); err != nil {
		return fmt.Errorf("project does not build after installing extension: %w", err)
	}

	fmt.Fprintf(os.Stderr, "\nextension '%s' installed successfully.\n", name)
	fmt.Fprintf(os.Stderr, "\nTo activate, register it in cmd/beluga/main.go:\n")
	fmt.Fprintf(os.Stderr, "  1. import \"github.com/collinpfeifer/beluga/internal/extensions/%s\"\n", name)
	fmt.Fprintf(os.Stderr, "  2. Add case in lookupBuiltinExtension:\n")
	fmt.Fprintf(os.Stderr, "     case \"%s\":\n", name)
	fmt.Fprintf(os.Stderr, "         return &%s.Extension{}\n", packageName(name))
	fmt.Fprintf(os.Stderr, "  3. Add config to beluga.yaml:\n")
	fmt.Fprintf(os.Stderr, "     extensions:\n")
	fmt.Fprintf(os.Stderr, "       %s:\n", name)
	fmt.Fprintf(os.Stderr, "         enabled: true\n")
	fmt.Fprintf(os.Stderr, "\nThen restart: beluga start\n")

	return nil
}

// installRemote builds the extension as a standalone binary.
func installRemote(srcDir, name, projectRoot string) error {
	// Build the binary.
	binDir := filepath.Join(projectRoot, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return fmt.Errorf("creating bin directory: %w", err)
	}

	outputPath := filepath.Join(binDir, name)
	buildCmd := exec.Command("go", "build", "-o", outputPath, ".")
	buildCmd.Dir = srcDir
	buildCmd.Stderr = os.Stderr
	if err := buildCmd.Run(); err != nil {
		return fmt.Errorf("building remote extension: %w", err)
	}

	fmt.Fprintf(os.Stderr, "\nremote extension '%s' built: %s\n", name, outputPath)
	fmt.Fprintf(os.Stderr, "\nTo run as a remote extension:\n")
	fmt.Fprintf(os.Stderr, "  1. Enable ext_host in beluga.yaml\n")
	fmt.Fprintf(os.Stderr, "  2. Start beluga: beluga start\n")
	fmt.Fprintf(os.Stderr, "  3. Start the extension: %s\n", outputPath)
	fmt.Fprintf(os.Stderr, "\nThe extension will connect to ext_host's gRPC server.\n")

	return nil
}

// packageName converts an extension name to a valid Go package name.
func packageName(name string) string {
	pkg := strings.ToLower(name)
	pkg = strings.ReplaceAll(pkg, "-", "_")
	return pkg
}
