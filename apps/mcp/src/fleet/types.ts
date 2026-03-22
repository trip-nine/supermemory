// =============================================================
// Fleet Memory Prototype — TypeScript Types
// =============================================================

export type MemoryType = "episodic" | "semantic" | "procedural"

export type PrincipalKind = "user" | "agent" | "service"

export type ActorRole = "user" | "agent" | "tool" | "system"

export type ContentType = "text" | "tool_call" | "tool_result" | "event"

export type MemoryScope = "session" | "user" | "org" | "global"

export type FactCategory =
	| "preference"
	| "identity"
	| "relationship"
	| "decision"
	| "context"

export type AuditAction =
	| "read"
	| "write"
	| "delete"
	| "compact"
	| "share"
	| "correct"
	| "erasure"
	| "quarantine"

export type SanitizationAction = "allow" | "quarantine"

// ── Identity ─────────────────────────────────────────────────

export interface Tenant {
	id: string
	name: string
	created_at: string
	settings: TenantSettings
}

export interface TenantSettings {
	episodic?: {
		raw_retention_days: number
		compacted_retention_days: number
		auto_compact_after_hours: number
	}
	semantic?: {
		retention: "indefinite" | number
		review_cycle_days: number
	}
	procedural?: {
		retention: "indefinite" | number
		deprecate_after_failures: number
	}
	audit_log?: {
		retention_days: number
	}
}

export interface Principal {
	id: string
	tenant_id: string
	kind: PrincipalKind
	external_id?: string
	metadata: Record<string, unknown>
	created_at: string
}

export interface Session {
	id: string
	tenant_id: string
	user_id: string
	agent_id: string
	started_at: string
	ended_at?: string
	metadata: Record<string, unknown>
}

// ── Episodic Memory ───────────────────────────────────────────

export interface Episode {
	id: string
	tenant_id: string
	session_id: string
	actor_id: string
	actor_role: ActorRole
	content: string
	content_type: ContentType
	importance: number
	created_at: string
	expires_at?: string
	compacted: boolean
	quarantined: boolean
	risk_score: number
	risk_flags: string[]
	provenance: EpisodeProvenance
}

export interface EpisodeProvenance {
	source_agent?: string
	confidence?: number
	chain?: string[]
}

// ── Semantic Memory ───────────────────────────────────────────

export interface Fact {
	id: string
	tenant_id: string
	subject_id: string
	scope: MemoryScope
	category: FactCategory
	key: string
	value: string
	confidence: number
	source_episodes: string[]
	created_at: string
	updated_at: string
	superseded_by?: string
	created_by: string
}

// ── Procedural Memory ─────────────────────────────────────────

export interface Procedure {
	id: string
	tenant_id: string
	scope: MemoryScope
	name: string
	description: string
	trigger_pattern?: string
	steps: ProcedureStep[]
	success_count: number
	failure_count: number
	version: number
	source_episodes: string[]
	created_at: string
	updated_at: string
	created_by: string
}

export interface ProcedureStep {
	order: number
	action: string
	description: string
	parameters?: Record<string, unknown>
}

// ── Gateway / Request Context ─────────────────────────────────

export interface GatewayContext {
	tenant_id: string
	principal_id: string
	agent_id: string
	session_id?: string
}

// ── Sanitization ──────────────────────────────────────────────

export interface SanitizationResult {
	content: string
	action: SanitizationAction
	risk_score: number
	flags: string[]
}

// ── Recall Results ────────────────────────────────────────────

export interface RecalledMemory {
	memory_type: MemoryType
	id: string
	content: string
	confidence: number
	created_at: string
	relevance_score?: number
	provenance?: EpisodeProvenance
}

export interface RecallResponse {
	memories: RecalledMemory[]
	total: number
	query: string
}

// ── Compaction ────────────────────────────────────────────────

export interface ExtractedFact {
	category: FactCategory
	key: string
	value: string
	confidence: number
	is_correction: boolean
	existing_key?: string
}

export interface CompactionResult {
	episodes_processed: number
	facts_created: number
	facts_updated: number
	conflicts_flagged: number
	errors: string[]
}

// ── Fleet Propagation ─────────────────────────────────────────

export interface FactChangeEvent {
	action: "INSERT" | "UPDATE" | "DELETE"
	fact_id: string
	subject_id: string
	scope: MemoryScope
	key: string
	category: FactCategory
}

export interface WarmStartResult {
	user_profile: RecalledMemory[]
	recent_context: RecalledMemory[]
	relevant_procedures: RecalledMemory[]
}
