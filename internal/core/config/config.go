package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Config is the top-level configuration for Beluga.
type Config struct {
	LLM        LLMConfig                  `yaml:"llm"`
	Database   DatabaseConfig             `yaml:"database"`
	Workspace  WorkspaceConfig            `yaml:"workspace"`
	Agent      AgentConfig                `yaml:"agent"`
	Extensions map[string]ExtensionConfig `yaml:"extensions"`
}

// LLMConfig holds configuration for the OpenAI-compatible LLM endpoint.
type LLMConfig struct {
	Endpoint            string `yaml:"endpoint"`
	APIKey              string `yaml:"api_key"`
	Model               string `yaml:"model"`
	EmbeddingModel      string `yaml:"embedding_model,omitempty"`
	EmbeddingDimensions int    `yaml:"embedding_dimensions,omitempty"`
}

// DatabaseConfig holds PostgreSQL connection parameters.
type DatabaseConfig struct {
	Host           string `yaml:"host"`
	Port           int    `yaml:"port"`
	Name           string `yaml:"name"`
	User           string `yaml:"user"`
	Password       string `yaml:"password"`
	SSLMode        string `yaml:"sslmode"`
	MaxConnections int    `yaml:"max_connections"`
}

// DSN returns the PostgreSQL connection string.
func (d DatabaseConfig) DSN() string {
	return fmt.Sprintf(
		"postgres://%s:%s@%s:%d/%s?sslmode=%s",
		d.User, d.Password, d.Host, d.Port, d.Name, d.SSLMode,
	)
}

// WorkspaceConfig holds Docker sandbox defaults.
type WorkspaceConfig struct {
	DockerHost    string        `yaml:"docker_host"`
	AgentImage    string        `yaml:"agent_image"`
	MaxConcurrent int           `yaml:"max_concurrent"`
	IdleTimeout   time.Duration `yaml:"idle_timeout"`
	CPULimit      string        `yaml:"cpu_limit"`
	MemoryLimit   string        `yaml:"memory_limit"`
	NetworkMode   string        `yaml:"network_mode"`
}

// AgentConfig holds agent loop behavior settings.
type AgentConfig struct {
	MaxIterations    int `yaml:"max_iterations"`
	MaxContextTokens int `yaml:"max_context_tokens"`
}

// Defaults returns an AgentConfig with sensible defaults.
func (a AgentConfig) Defaults() AgentConfig {
	if a.MaxIterations == 0 {
		a.MaxIterations = 30
	}
	if a.MaxContextTokens == 0 {
		a.MaxContextTokens = 128000
	}
	return a
}

// ExtensionConfig holds configuration for a single extension.
type ExtensionConfig struct {
	Enabled bool            `yaml:"enabled"`
	Config  json.RawMessage `yaml:"config"`
}

// LoadConfig reads a YAML config file and applies environment variable overrides.
func LoadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading config file: %w", err)
	}

	cfg := &Config{}
	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parsing config file: %w", err)
	}

	// Apply environment variable overrides.
	if v := os.Getenv("BELUGA_LLM_API_KEY"); v != "" {
		cfg.LLM.APIKey = v
	}
	if v := os.Getenv("BELUGA_LLM_ENDPOINT"); v != "" {
		cfg.LLM.Endpoint = v
	}
	if v := os.Getenv("BELUGA_LLM_MODEL"); v != "" {
		cfg.LLM.Model = v
	}
	if v := os.Getenv("BELUGA_DB_HOST"); v != "" {
		cfg.Database.Host = v
	}
	if v := os.Getenv("BELUGA_DB_PASSWORD"); v != "" {
		cfg.Database.Password = v
	}

	// Apply defaults.
	cfg.Agent = cfg.Agent.Defaults()
	if cfg.Workspace.NetworkMode == "" {
		cfg.Workspace.NetworkMode = "none"
	}

	return cfg, nil
}

// IsExtensionEnabled returns true if the named extension exists and is enabled.
func (c *Config) IsExtensionEnabled(name string) bool {
	ext, ok := c.Extensions[name]
	return ok && ext.Enabled
}

// ExtensionConfig returns the raw config for the named extension, or nil.
func (c *Config) ExtensionRawConfig(name string) json.RawMessage {
	ext, ok := c.Extensions[name]
	if !ok {
		return nil
	}
	if ext.Config == nil {
		return json.RawMessage(`{}`)
	}
	return ext.Config
}

// EnabledExtensions returns extension names in their config order that are enabled.
func (c *Config) EnabledExtensions() []string {
	var names []string
	for name, ext := range c.Extensions {
		if ext.Enabled {
			names = append(names, name)
		}
	}
	return names
}

// ResolveEnvVars replaces ${VAR} or $VAR patterns in string fields.
// This is a convenience for config values that reference env vars.
func ResolveEnvVars(s string) string {
	for strings.Contains(s, "${") || strings.Contains(s, "$") {
		before := s
		s = os.ExpandEnv(s)
		if s == before {
			break
		}
	}
	return s
}
