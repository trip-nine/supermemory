-- =============================================================
-- Fleet Memory Prototype — Database Schema
-- Multi-agent, multi-tenant persistent memory for AI agent fleets
-- =============================================================

CREATE SCHEMA IF NOT EXISTS memory;

-- ══════════════════════════════════════════════════════════════
-- CORE IDENTITY TABLES
-- ══════════════════════════════════════════════════════════════

-- Tenants (organizations)
CREATE TABLE memory.tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  settings    JSONB DEFAULT '{}'::jsonb  -- retention policies, etc.
);

-- Principals (users, agents, services)
CREATE TABLE memory.principals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES memory.tenants(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('user', 'agent', 'service')),
  external_id TEXT,  -- e.g., auth0 sub, agent instance ID
  metadata    JSONB DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_principals_tenant ON memory.principals(tenant_id);
CREATE INDEX idx_principals_external ON memory.principals(tenant_id, external_id);

-- Sessions (conversation containers)
CREATE TABLE memory.sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES memory.tenants(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES memory.principals(id),
  agent_id    UUID NOT NULL REFERENCES memory.principals(id),
  started_at  TIMESTAMPTZ DEFAULT now(),
  ended_at    TIMESTAMPTZ,
  metadata    JSONB DEFAULT '{}'::jsonb  -- channel, context, etc.
);

CREATE INDEX idx_sessions_tenant ON memory.sessions(tenant_id);
CREATE INDEX idx_sessions_user ON memory.sessions(user_id);
CREATE INDEX idx_sessions_agent ON memory.sessions(agent_id);

-- ══════════════════════════════════════════════════════════════
-- EPISODIC MEMORY  (What happened)
-- High write frequency, subject to TTL and compaction
-- ══════════════════════════════════════════════════════════════

CREATE TABLE memory.episodes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES memory.tenants(id) ON DELETE CASCADE,
  session_id   UUID NOT NULL REFERENCES memory.sessions(id) ON DELETE CASCADE,
  actor_id     UUID NOT NULL REFERENCES memory.principals(id),
  actor_role   TEXT NOT NULL CHECK (actor_role IN ('user', 'agent', 'tool', 'system')),
  content      TEXT NOT NULL,
  content_type TEXT DEFAULT 'text' CHECK (content_type IN ('text', 'tool_call', 'tool_result', 'event')),
  embedding    vector(1536),  -- OpenAI ada-002 or equivalent
  importance   FLOAT DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  created_at   TIMESTAMPTZ DEFAULT now(),
  expires_at   TIMESTAMPTZ,  -- TTL for auto-cleanup
  compacted    BOOLEAN DEFAULT false,  -- true after distilled into semantic memory
  quarantined  BOOLEAN DEFAULT false,  -- true if flagged by sanitization
  risk_score   FLOAT DEFAULT 0.0,
  risk_flags   JSONB DEFAULT '[]'::jsonb,
  provenance   JSONB DEFAULT '{}'::jsonb  -- source agent, confidence, chain
);

CREATE INDEX idx_episodes_tenant ON memory.episodes(tenant_id);
CREATE INDEX idx_episodes_session ON memory.episodes(session_id);
CREATE INDEX idx_episodes_created ON memory.episodes(tenant_id, created_at DESC);
CREATE INDEX idx_episodes_uncompacted ON memory.episodes(tenant_id, compacted, created_at)
  WHERE compacted = false AND quarantined = false;
CREATE INDEX idx_episodes_embedding ON memory.episodes
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ══════════════════════════════════════════════════════════════
-- SEMANTIC MEMORY  (What we know)
-- Distilled facts, preferences, relationships, decisions
-- ══════════════════════════════════════════════════════════════

CREATE TABLE memory.facts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES memory.tenants(id) ON DELETE CASCADE,
  subject_id      UUID NOT NULL REFERENCES memory.principals(id),  -- who/what this fact is about
  scope           TEXT NOT NULL CHECK (scope IN ('user', 'org', 'global')),
  category        TEXT NOT NULL CHECK (category IN ('preference', 'identity', 'relationship', 'decision', 'context')),
  key             TEXT NOT NULL,  -- human-readable key, e.g., 'bible_translation_preference'
  value           TEXT NOT NULL,  -- the fact itself
  confidence      FLOAT DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  embedding       vector(1536),
  source_episodes UUID[] DEFAULT '{}',  -- provenance chain to episodes
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  superseded_by   UUID REFERENCES memory.facts(id),  -- correction chain
  created_by      UUID NOT NULL REFERENCES memory.principals(id),  -- which agent wrote this

  -- One active fact per key per subject (correction chain handles updates)
  UNIQUE(tenant_id, subject_id, scope, category, key)
);

CREATE INDEX idx_facts_tenant ON memory.facts(tenant_id);
CREATE INDEX idx_facts_subject ON memory.facts(subject_id);
CREATE INDEX idx_facts_active ON memory.facts(tenant_id, subject_id, scope)
  WHERE superseded_by IS NULL;
CREATE INDEX idx_facts_embedding ON memory.facts
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ══════════════════════════════════════════════════════════════
-- PROCEDURAL MEMORY  (What we've learned to do)
-- Learned workflows, tool sequences, interaction patterns
-- ══════════════════════════════════════════════════════════════

CREATE TABLE memory.procedures (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES memory.tenants(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL CHECK (scope IN ('agent', 'user', 'org', 'global')),
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  trigger_pattern TEXT,  -- when to activate this procedure
  steps           JSONB NOT NULL,  -- ordered action sequence
  embedding       vector(1536),
  success_count   INT DEFAULT 0,
  failure_count   INT DEFAULT 0,
  version         INT DEFAULT 1,
  source_episodes UUID[] DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  created_by      UUID NOT NULL REFERENCES memory.principals(id)
);

CREATE INDEX idx_procedures_tenant ON memory.procedures(tenant_id);
CREATE INDEX idx_procedures_embedding ON memory.procedures
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ══════════════════════════════════════════════════════════════
-- AUDIT LOG  (append-only, never deleted except by compliance policy)
-- ══════════════════════════════════════════════════════════════

CREATE TABLE memory.audit_log (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL,
  principal_id  UUID NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('read', 'write', 'delete', 'compact', 'share', 'correct', 'erasure', 'quarantine')),
  target_table  TEXT NOT NULL,
  target_id     UUID,
  detail        JSONB DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_audit_tenant ON memory.audit_log(tenant_id, created_at DESC);
CREATE INDEX idx_audit_principal ON memory.audit_log(principal_id);

-- ══════════════════════════════════════════════════════════════
-- FACT CONFLICTS  (flagged for resolution when confidence delta ≤ 0.3)
-- ══════════════════════════════════════════════════════════════

CREATE TABLE memory.fact_conflicts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES memory.tenants(id) ON DELETE CASCADE,
  fact_a_id       UUID NOT NULL REFERENCES memory.facts(id),
  fact_b_id       UUID NOT NULL REFERENCES memory.facts(id),
  confidence_delta FLOAT NOT NULL,
  resolved        BOOLEAN DEFAULT false,
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID REFERENCES memory.principals(id),
  resolution      TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- ══════════════════════════════════════════════════════════════
-- ROW-LEVEL SECURITY  (default deny, tenant isolation)
-- ══════════════════════════════════════════════════════════════

-- Enable RLS on ALL memory tables
ALTER TABLE memory.episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory.episodes FORCE ROW LEVEL SECURITY;
ALTER TABLE memory.facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory.facts FORCE ROW LEVEL SECURITY;
ALTER TABLE memory.procedures ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory.procedures FORCE ROW LEVEL SECURITY;
ALTER TABLE memory.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory.sessions FORCE ROW LEVEL SECURITY;

-- The app connects as role 'memory_agent' (never superuser, never BYPASSRLS)
CREATE ROLE memory_agent NOINHERIT LOGIN;

-- Tenant isolation policy: agents can only see their tenant's data
-- current_setting('app.tenant_id') is set per-request by the Memory Gateway
CREATE POLICY tenant_isolation ON memory.episodes
  FOR ALL TO memory_agent
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE POLICY tenant_isolation ON memory.facts
  FOR ALL TO memory_agent
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE POLICY tenant_isolation ON memory.procedures
  FOR ALL TO memory_agent
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE POLICY tenant_isolation ON memory.sessions
  FOR ALL TO memory_agent
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

-- Scope-based visibility within a tenant
-- User-scoped facts: only visible to the subject user and their agents
CREATE POLICY user_scope ON memory.facts
  FOR SELECT TO memory_agent
  USING (
    (scope = 'user' AND subject_id = current_setting('app.principal_id')::uuid)
    OR scope IN ('org', 'global')
  );

-- Agents never see quarantined memories
CREATE POLICY no_quarantine ON memory.episodes
  FOR SELECT TO memory_agent
  USING (quarantined = false);

-- ══════════════════════════════════════════════════════════════
-- FLEET PROPAGATION  (pg_notify push events)
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION memory.notify_fact_change()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify(
    'memory_' || NEW.tenant_id::text,
    json_build_object(
      'action', TG_OP,
      'fact_id', NEW.id,
      'subject_id', NEW.subject_id,
      'scope', NEW.scope,
      'key', NEW.key,
      'category', NEW.category
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fact_change_trigger
  AFTER INSERT OR UPDATE ON memory.facts
  FOR EACH ROW EXECUTE FUNCTION memory.notify_fact_change();

-- ══════════════════════════════════════════════════════════════
-- CONFLICT DETECTION VIEW
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW memory.v_fact_conflicts AS
SELECT
  f1.id           AS fact_a,
  f2.id           AS fact_b,
  f1.tenant_id,
  f1.subject_id,
  f1.key,
  f1.value        AS value_a,
  f2.value        AS value_b,
  f1.confidence   AS confidence_a,
  f2.confidence   AS confidence_b,
  ABS(f1.confidence - f2.confidence) AS confidence_delta
FROM memory.facts f1
JOIN memory.facts f2
  ON  f1.tenant_id  = f2.tenant_id
  AND f1.subject_id = f2.subject_id
  AND f1.key        = f2.key
  AND f1.id         < f2.id
  AND f1.superseded_by IS NULL
  AND f2.superseded_by IS NULL;

-- ══════════════════════════════════════════════════════════════
-- RETENTION: auto-expire episodes via scheduled cleanup
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION memory.cleanup_expired_episodes()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM memory.episodes
  WHERE expires_at IS NOT NULL AND expires_at < now();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
