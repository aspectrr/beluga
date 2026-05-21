package agent

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/aspectrr/beluga/internal/core/model"
)

const (
	// MaxContextTokens is a rough upper bound on context window.
	MaxContextTokens = 128000

	// Rough estimate: 1 token ≈ 4 characters.
	charsPerToken = 4

	// DefaultSystemPrompt is the base system prompt used when no .beluga/SYSTEM.md is found.
	DefaultSystemPrompt = `You are Beluga, a managed agent. You work in a sandboxed workspace where you can read and write files and execute commands.

You are invoked through connectors (ClickUp, Slack, etc.). The user CANNOT see your internal reasoning or tool outputs.
You MUST post your final response through the appropriate connector tool so the user can read it.

Available capabilities:
- Read and write files in your workspace sandbox
- Execute bash commands in your workspace sandbox
- Extensions may add additional tools

Guidelines:
- Always post your final answer through the appropriate connector before finishing
- Be thorough but concise in your explanations
- If you encounter unfamiliar issues, search for relevant context`
)

// ContextBuilder constructs the message array for the LLM from session events.
type ContextBuilder struct {
	systemPrompt string
	tools        []ToolDef
	maxTokens    int
}

// NewContextBuilder creates a new context builder with the default system prompt.
func NewContextBuilder() *ContextBuilder {
	return &ContextBuilder{
		systemPrompt: DefaultSystemPrompt,
		maxTokens:    MaxContextTokens,
	}
}

// NewContextBuilderWithPrompt creates a new context builder with a custom system prompt.
func NewContextBuilderWithPrompt(prompt string) *ContextBuilder {
	return &ContextBuilder{
		systemPrompt: prompt,
		maxTokens:    MaxContextTokens,
	}
}

// SetSystemPrompt overrides the base system prompt.
func (cb *ContextBuilder) SetSystemPrompt(prompt string) {
	cb.systemPrompt = prompt
}

// SetTools sets the available tool definitions.
func (cb *ContextBuilder) SetTools(tools []ToolDef) {
	cb.tools = tools
}

// MaxTokens returns the configured max token limit.
func (cb *ContextBuilder) MaxTokens() int {
	return cb.maxTokens
}

// SetMaxTokens overrides the max token limit.
func (cb *ContextBuilder) SetMaxTokens(n int) {
	cb.maxTokens = n
}

// Build constructs the chat messages from session events.
// If a compacted event exists, it uses the summary as context and only converts
// events after the compaction point. Otherwise, converts all events and truncates
// if the context window is exceeded.
func (cb *ContextBuilder) Build(events []model.Event) []ChatMessage {
	// Build system message.
	systemContent := cb.systemPrompt

	// Find the most recent compacted event.
	var latestCompacted *model.CompactedPayload
	var startIdx int
	for i, evt := range events {
		if evt.Type == model.EventTypeCompacted {
			var p model.CompactedPayload
			if err := json.Unmarshal(evt.Data, &p); err == nil {
				latestCompacted = &p
				startIdx = i + 1
			}
		}
	}

	// If we have a compacted summary, inject it after the system prompt.
	if latestCompacted != nil {
		systemContent += "\n\n## Previous Conversation Summary\n\n" + latestCompacted.Summary
	}

	messages := []ChatMessage{{Role: "system", Content: systemContent}}

	// Convert events after the compaction point.
	for _, evt := range events[startIdx:] {
		msgs := cb.eventToMessages(evt)
		messages = append(messages, msgs...)
	}

	// Truncate from the front (keep system + recent events) if over budget.
	messages = cb.truncate(messages)

	return messages
}

// eventToMessages converts a single event to one or more chat messages.
func (cb *ContextBuilder) eventToMessages(evt model.Event) []ChatMessage {
	switch evt.Type {
	case model.EventTypeUserMessage:
		var p model.UserMessagePayload
		if err := json.Unmarshal(evt.Data, &p); err != nil {
			return nil
		}
		content := p.Content
		if len(p.Attachments) > 0 {
			content += "\n\nAttachments: " + strings.Join(p.Attachments, ", ")
		}
		return []ChatMessage{{Role: "user", Content: content}}

	case model.EventTypeAgentMessage:
		var p model.AgentMessagePayload
		if err := json.Unmarshal(evt.Data, &p); err != nil {
			return nil
		}
		return []ChatMessage{{Role: "assistant", Content: p.Content}}

	case model.EventTypeToolCall:
		var p model.ToolCallPayload
		if err := json.Unmarshal(evt.Data, &p); err != nil {
			return nil
		}
		return []ChatMessage{
			{
				Role: "assistant",
				ToolCalls: []ToolCall{
					{
						ID:   p.CallID,
						Type: "function",
						Function: FunctionCall{
							Name:      p.ToolName,
							Arguments: string(p.Args),
						},
					},
				},
			},
		}

	case model.EventTypeToolResult:
		var p model.ToolResultPayload
		if err := json.Unmarshal(evt.Data, &p); err != nil {
			return nil
		}
		content := p.Output
		if p.IsError {
			content = "Error: " + content
		}
		return []ChatMessage{
			{
				Role:       "tool",
				Content:    content,
				ToolCallID: p.CallID,
			},
		}

	case model.EventTypeInterrupt:
		var p model.InterruptPayload
		if err := json.Unmarshal(evt.Data, &p); err != nil {
			return nil
		}
		return []ChatMessage{
			{
				Role:    "system",
				Content: fmt.Sprintf("[Interrupt: %s]", p.Reason),
			},
		}

	case model.EventTypeStatusTransition:
		// Status transitions are not sent to the LLM.
		return nil

	case model.EventTypeError:
		var p model.ErrorPayload
		if err := json.Unmarshal(evt.Data, &p); err != nil {
			return nil
		}
		return []ChatMessage{
			{
				Role:    "system",
				Content: fmt.Sprintf("[Error: %s]", p.Message),
			},
		}

	case model.EventTypeCompacted:
		// Compacted events are handled by Build() directly.
		return nil

	default:
		return nil
	}
}

// truncate removes oldest messages (keeping system prompt) if over budget.
func (cb *ContextBuilder) truncate(messages []ChatMessage) []ChatMessage {
	if len(messages) <= 1 {
		return messages
	}

	// Always keep the system message at index 0.
	system := messages[0]
	rest := messages[1:]

	for cb.EstimateTokens(append([]ChatMessage{system}, rest...)) > cb.maxTokens && len(rest) > 1 {
		rest = rest[1:]
	}

	return append([]ChatMessage{system}, rest...)
}

// EstimateTokens gives a rough token count for the messages.
func (cb *ContextBuilder) EstimateTokens(messages []ChatMessage) int {
	total := 0
	for _, m := range messages {
		total += len(m.Content) / charsPerToken
		for _, tc := range m.ToolCalls {
			total += len(tc.Function.Arguments) / charsPerToken
			total += len(tc.Function.Name) / charsPerToken
		}
	}
	return total
}
