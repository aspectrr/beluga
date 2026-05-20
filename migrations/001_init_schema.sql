-- +goose Up
-- Beluga schema: sessions and events only.
-- Skills and history are managed by extensions (evolving-skills, searchable-history).

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source      TEXT    NOT NULL,              -- e.g. "clickup", "slack"
    source_id   TEXT    NOT NULL,              -- e.g. ClickUp task ID
    status      TEXT    NOT NULL DEFAULT 'pending',
                    -- pending | running | suspended | completed | failed
    sandbox_id  TEXT,
    metadata    JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX sessions_source_idx ON sessions (source, source_id);
CREATE INDEX sessions_status_idx ON sessions (status);
CREATE INDEX sessions_updated_at_idx ON sessions (updated_at);

-- ---------------------------------------------------------------------------
-- Events (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE events (
    id          BIGSERIAL PRIMARY KEY,
    session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq         BIGINT NOT NULL,
    type        TEXT NOT NULL,
            -- user_message | agent_message | tool_call | tool_result
            -- interrupt | status_transition | error | compacted
    data        JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (session_id, seq)
);

CREATE INDEX events_session_seq_idx ON events (session_id, seq);
CREATE INDEX events_type_idx ON events (session_id, type);
CREATE INDEX events_data_idx ON events USING gin (data);

-- ---------------------------------------------------------------------------
-- Helper: updated_at trigger
-- ---------------------------------------------------------------------------
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION beluga_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

CREATE TRIGGER sessions_updated_at
    BEFORE UPDATE ON sessions
    FOR EACH ROW EXECUTE FUNCTION beluga_set_updated_at();

-- +goose Down
DROP TRIGGER IF EXISTS sessions_updated_at ON sessions;
DROP FUNCTION IF EXISTS beluga_set_updated_at;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS sessions;
