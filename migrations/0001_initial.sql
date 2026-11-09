-- 2earl MCP gateway (docs/DESIGN.md §8).

-- One row per tool of each service behind the gateway: a hash of what the assistant sees (name,
-- description, input schema, annotations, required scope). A changed hash is re-approved
-- (third-party) or audited (first-party) before the tool is offered again (DESIGN §6.3).
CREATE TABLE tool_pins (
  upstream      TEXT    NOT NULL,
  tool          TEXT    NOT NULL,
  hash          TEXT    NOT NULL,
  status        TEXT    NOT NULL CHECK (status IN ('approved', 'pending')),
  first_seen_at INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (upstream, tool)
) STRICT;

-- What happened, never what was said: tool names and outcomes, no arguments or results.
-- 90 days. actor_user_id is login's internal user ID, re-keyed when the account is deleted.
CREATE TABLE audit_events (
  id            TEXT    PRIMARY KEY,
  at            INTEGER NOT NULL,
  event         TEXT    NOT NULL,
  actor_user_id TEXT,
  client_id     TEXT,
  detail        TEXT
) STRICT;
CREATE INDEX audit_events_actor ON audit_events (actor_user_id);
CREATE INDEX audit_events_at ON audit_events (at);
