package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/collinpfeifer/beluga/internal/core/eventstore"
	"github.com/collinpfeifer/beluga/internal/core/model"
	"github.com/collinpfeifer/beluga/internal/core/session"
)

// ToolExecutor is the interface for executing tools in the agent loop.
// This decouples the orchestrator from the tools package.
type ToolExecutor interface {
	ExecuteTool(ctx context.Context, name string, args json.RawMessage, sessionID string) (json.RawMessage, error)
}

// Orchestrator manages agent session lifecycles and runs the agent loop.
type Orchestrator struct {
	sessions     *session.Store
	events       *eventstore.Store
	llm          *LLMClient
	ctxBuilder   *ContextBuilder
	compactor    *Compactor
	toolExecutor ToolExecutor
	logger       *slog.Logger
}

// New creates a new orchestrator.
func New(
	sessions *session.Store,
	events *eventstore.Store,
	llm *LLMClient,
	toolExecutor ToolExecutor,
	logger *slog.Logger,
) *Orchestrator {
	ctxBuilder := NewContextBuilder()
	return &Orchestrator{
		sessions:     sessions,
		events:       events,
		llm:          llm,
		toolExecutor: toolExecutor,
		ctxBuilder:   ctxBuilder,
		compactor:    NewCompactor(events, llm, ctxBuilder, logger),
		logger:       logger,
	}
}

// NewWithPrompt creates a new orchestrator with a custom system prompt.
func NewWithPrompt(
	sessions *session.Store,
	events *eventstore.Store,
	llm *LLMClient,
	toolExecutor ToolExecutor,
	systemPrompt string,
	logger *slog.Logger,
) *Orchestrator {
	ctxBuilder := NewContextBuilderWithPrompt(systemPrompt)
	return &Orchestrator{
		sessions:     sessions,
		events:       events,
		llm:          llm,
		toolExecutor: toolExecutor,
		ctxBuilder:   ctxBuilder,
		compactor:    NewCompactor(events, llm, ctxBuilder, logger),
		logger:       logger,
	}
}

// SetTools wires tool definitions into the context builder so they are
// included in LLM chat completion requests.
func (o *Orchestrator) SetTools(tools []ToolDef) {
	o.ctxBuilder.SetTools(tools)
}

// StartRun begins an agent loop for the given session.
func (o *Orchestrator) StartRun(ctx context.Context, sessionID string) error {
	sess, err := o.sessions.Get(ctx, sessionID)
	if err != nil {
		return fmt.Errorf("getting session: %w", err)
	}

	if sess.Status != model.StatusPending && sess.Status != model.StatusSuspended {
		return fmt.Errorf("cannot start run for session in status %s", sess.Status)
	}

	// Transition to running.
	if err := o.sessions.UpdateStatus(ctx, sessionID, model.StatusRunning); err != nil {
		return fmt.Errorf("updating status to running: %w", err)
	}

	// Record the status transition event.
	if _, err := o.appendTransition(ctx, sessionID, sess.Status, model.StatusRunning); err != nil {
		return fmt.Errorf("recording status transition: %w", err)
	}

	// Run the agent loop in a goroutine.
	go o.runLoop(context.Background(), sessionID)

	return nil
}

// Interrupt gracefully interrupts a running session.
func (o *Orchestrator) Interrupt(ctx context.Context, sessionID string) error {
	sess, err := o.sessions.Get(ctx, sessionID)
	if err != nil {
		return fmt.Errorf("getting session: %w", err)
	}

	if sess.Status != model.StatusRunning {
		return fmt.Errorf("cannot interrupt session in status %s", sess.Status)
	}

	if err := o.sessions.UpdateStatus(ctx, sessionID, model.StatusSuspended); err != nil {
		return fmt.Errorf("updating status to suspended: %w", err)
	}

	_, _ = o.events.Append(ctx, sessionID, model.EventTypeInterrupt, mustJSON(model.InterruptPayload{
		Reason:         "interrupted by user",
		RequiresAction: true,
	}))

	_, _ = o.appendTransition(ctx, sessionID, model.StatusRunning, model.StatusSuspended)
	return nil
}

// Resume resumes a suspended session.
func (o *Orchestrator) Resume(ctx context.Context, sessionID string) error {
	return o.StartRun(ctx, sessionID)
}

// Terminate kills the session and marks it completed or failed.
func (o *Orchestrator) Terminate(ctx context.Context, sessionID string, failed bool) error {
	sess, err := o.sessions.Get(ctx, sessionID)
	if err != nil {
		return fmt.Errorf("getting session: %w", err)
	}

	newStatus := model.StatusCompleted
	if failed {
		newStatus = model.StatusFailed
	}

	if err := o.sessions.UpdateStatus(ctx, sessionID, newStatus); err != nil {
		return fmt.Errorf("updating status to %s: %w", newStatus, err)
	}

	_, _ = o.appendTransition(ctx, sessionID, sess.Status, newStatus)

	o.logger.Info("session terminated",
		"session_id", sessionID,
		"status", newStatus,
	)
	return nil
}

// HandleNewSession creates a new session and starts the agent loop.
// This is the callback passed to extensions via ExtensionContext.CreateSession.
func (o *Orchestrator) HandleNewSession(ctx context.Context, source, sourceID string, initialMessage string, metadata json.RawMessage) (*model.Session, error) {
	sess, err := o.sessions.Create(ctx, source, sourceID, metadata)
	if err != nil {
		return nil, fmt.Errorf("creating session: %w", err)
	}

	// Seed the session with the initial user message if provided.
	if initialMessage != "" {
		if _, err := o.events.Append(ctx, sess.ID, model.EventTypeUserMessage, mustJSON(model.UserMessagePayload{
			Content: initialMessage,
		})); err != nil {
			return nil, fmt.Errorf("seeding user message: %w", err)
		}
	}

	if err := o.StartRun(ctx, sess.ID); err != nil {
		return nil, fmt.Errorf("starting run: %w", err)
	}

	return sess, nil
}

// runLoop is the main agent loop. It runs in a goroutine.
func (o *Orchestrator) runLoop(ctx context.Context, sessionID string) {
	logger := o.logger.With("session_id", sessionID)
	logger.Info("agent loop started")

	const maxIterations = 30
	for iteration := 0; iteration < maxIterations; iteration++ {
		// Check if session is still running.
		sess, err := o.sessions.Get(ctx, sessionID)
		if err != nil {
			logger.Error("failed to get session", "error", err)
			_ = o.Terminate(ctx, sessionID, true)
			return
		}
		if sess.Status != model.StatusRunning {
			logger.Info("session no longer running, stopping loop", "status", sess.Status)
			return
		}

		// Build context from session events.
		events, err := o.events.GetEvents(ctx, sessionID, 0, 10000)
		if err != nil {
			logger.Error("failed to get events", "error", err)
			_ = o.Terminate(ctx, sessionID, true)
			return
		}

		messages := o.ctxBuilder.Build(events)

		// Check if context needs compaction before calling the LLM.
		if o.compactor.NeedsCompaction(messages) {
			logger.Info("context approaching limit, triggering compaction",
				"estimated_tokens", o.ctxBuilder.EstimateTokens(messages),
				"max_tokens", o.ctxBuilder.MaxTokens(),
			)
			tokensSaved, err := o.compactor.Compact(ctx, sessionID, events)
			if err != nil {
				logger.Error("compaction failed", "error", err)
				// Don't terminate — just continue with the truncated context.
			} else if tokensSaved > 0 {
				// Re-fetch events and rebuild context after compaction.
				events, err = o.events.GetEvents(ctx, sessionID, 0, 10000)
				if err != nil {
					logger.Error("failed to get events after compaction", "error", err)
					_ = o.Terminate(ctx, sessionID, true)
					return
				}
				messages = o.ctxBuilder.Build(events)
				logger.Info("context compacted, rebuilt messages",
					"estimated_tokens", o.ctxBuilder.EstimateTokens(messages),
					"tokens_saved", tokensSaved,
				)
			}
		}

		logger.Info("calling LLM",
			"model", o.llm.Model(),
			"message_count", len(messages),
			"tools_count", len(o.ctxBuilder.tools),
		)

		resp, err := o.llm.Chat(ctx, ChatRequest{
			Model:    "", // use default from config
			Messages: messages,
			Tools:    o.ctxBuilder.tools,
		})
		if err != nil {
			logger.Error("LLM call failed", "error", err)
			_, _ = o.events.Append(ctx, sessionID, model.EventTypeError, mustJSON(model.ErrorPayload{
				Message:     fmt.Sprintf("LLM call failed: %v", err),
				Recoverable: true,
			}))
			_ = o.Terminate(ctx, sessionID, true)
			return
		}

		pt, ct, tt := 0, 0, 0
		if resp.Usage != nil {
			pt = resp.Usage.PromptTokens
			ct = resp.Usage.CompletionTokens
			tt = resp.Usage.TotalTokens
		}
		logger.Info("LLM response received",
			"choices", len(resp.Choices),
			"prompt_tokens", pt,
			"completion_tokens", ct,
			"total_tokens", tt,
		)

		if len(resp.Choices) == 0 {
			logger.Error("LLM returned no choices")
			_ = o.Terminate(ctx, sessionID, true)
			return
		}

		choice := resp.Choices[0]

		logger.Info("LLM choice",
			"finish_reason", choice.FinishReason,
			"content_len", len(choice.Message.Content),
			"tool_calls", len(choice.Message.ToolCalls),
		)

		// Handle tool calls.
		if len(choice.Message.ToolCalls) > 0 {
			for _, tc := range choice.Message.ToolCalls {
				// Record the tool call event.
				_, _ = o.events.Append(ctx, sessionID, model.EventTypeToolCall, mustJSON(model.ToolCallPayload{
					ToolName: tc.Function.Name,
					Args:     json.RawMessage(tc.Function.Arguments),
					CallID:   tc.ID,
				}))

				// Execute the tool via the tool executor.
				var result json.RawMessage
				var toolErr error
				if o.toolExecutor != nil {
					result, toolErr = o.toolExecutor.ExecuteTool(ctx, tc.Function.Name, json.RawMessage(tc.Function.Arguments), sessionID)
				} else {
					result = nil
					toolErr = fmt.Errorf("tool %q execution not available", tc.Function.Name)
				}

				output := string(result)
				isError := false
				if toolErr != nil {
					output = toolErr.Error()
					isError = true
				}

				_, _ = o.events.Append(ctx, sessionID, model.EventTypeToolResult, mustJSON(model.ToolResultPayload{
					CallID:  tc.ID,
					Output:  output,
					IsError: isError,
				}))
			}
			// Continue the loop to process the next LLM turn.
			continue
		}

		// Handle agent message.
		if choice.Message.Content != "" {
			_, _ = o.events.Append(ctx, sessionID, model.EventTypeAgentMessage, mustJSON(model.AgentMessagePayload{
				Content:    choice.Message.Content,
				Model:      o.llm.Model(),
				TokensUsed: usageTokens(resp.Usage),
			}))

			// Check finish reason.
			switch choice.FinishReason {
			case "stop":
				// Agent is done.
				_ = o.Terminate(ctx, sessionID, false)
				return
			case "length":
				// Hit max tokens — continue the loop.
				logger.Info("LLM hit max tokens, continuing")
				continue
			default:
				logger.Info("LLM finished", "reason", choice.FinishReason)
				_ = o.Terminate(ctx, sessionID, false)
				return
			}
		}

		// No content and no tool calls — stop.
		logger.Warn("LLM returned empty message with no tool calls",
			"finish_reason", choice.FinishReason,
		)
		_ = o.Terminate(ctx, sessionID, false)
		return
	}
}

// appendTransition records a status transition event.
func (o *Orchestrator) appendTransition(ctx context.Context, sessionID, from, to string) (*model.Event, error) {
	return o.events.Append(ctx, sessionID, model.EventTypeStatusTransition, mustJSON(model.StatusTransitionPayload{
		From: from,
		To:   to,
	}))
}

// mustJSON marshals v to JSON, returning an empty object on error.
func mustJSON(v interface{}) json.RawMessage {
	data, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return json.RawMessage(data)
}

// usageTokens extracts total tokens from a ChatUsage, returning 0 if nil.
func usageTokens(u *ChatUsage) int {
	if u == nil {
		return 0
	}
	return u.TotalTokens
}
