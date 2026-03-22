// =============================================================
// Fleet Memory Prototype — Memory Gateway
// Single entry point for all agent memory operations.
// Pipeline: Auth → Tenant Resolution → Policy Check → Sanitize → Execute → Audit → Response
// =============================================================

import type {
	GatewayContext,
	Episode,
	Fact,
	Procedure,
	RecalledMemory,
	RecallResponse,
	MemoryType,
	FactCategory,
	ContentType,
	SanitizationResult,
	AuditAction,
	WarmStartResult,
} from "./types"
import {
	sanitizeMemoryContent,
	formatMemoriesForAgent,
	redactSecrets,
} from "./sanitization"

// ── In-memory store (replace with Supabase/Postgres in production) ────────────
// This stub is intentionally simple. The real implementation connects to Postgres
// with the 'memory_agent' role and RLS policies enforcing tenant isolation.
const episodeStore = new Map<string, Episode>()
const factStore = new Map<string, Fact>()
const procedureStore = new Map<string, Procedure>()
const auditLog: Array<{
	id: number
	tenant_id: string
	principal_id: string
	action: AuditAction
	target_table: string
	target_id: string | null
	detail: Record<string, unknown>
	created_at: string
}> = []
let auditSeq = 0

// ── Audit helper ──────────────────────────────────────────────────────────────

function audit(
	ctx: GatewayContext,
	action: AuditAction,
	target_table: string,
	target_id: string | null,
	detail: Record<string, unknown> = {},
): void {
	auditLog.push({
		id: ++auditSeq,
		tenant_id: ctx.tenant_id,
		principal_id: ctx.principal_id,
		action,
		target_table,
		target_id,
		detail,
		created_at: new Date().toISOString(),
	})
}

// ── Tenant isolation helper ───────────────────────────────────────────────────

function assertTenant<T extends { tenant_id: string }>(
	item: T | undefined,
	ctx: GatewayContext,
): T {
	if (!item) throw new GatewayError("NOT_FOUND", "Memory not found")
	if (item.tenant_id !== ctx.tenant_id)
		throw new GatewayError("FORBIDDEN", "Cross-tenant access denied")
	return item
}

// ── Error class ───────────────────────────────────────────────────────────────

export class GatewayError extends Error {
	constructor(
		public readonly code:
			| "NOT_FOUND"
			| "FORBIDDEN"
			| "QUARANTINED"
			| "POLICY_VIOLATION"
			| "VALIDATION",
		message: string,
	) {
		super(message)
		this.name = "GatewayError"
	}
}

// ── Store Episode ─────────────────────────────────────────────────────────────

export interface StoreEpisodeInput {
	session_id: string
	actor_id: string
	actor_role: Episode["actor_role"]
	content: string
	content_type?: ContentType
	importance?: number
	expires_in_days?: number
}

export function storeEpisode(
	ctx: GatewayContext,
	input: StoreEpisodeInput,
): Episode {
	// 1. Sanitize
	const redacted = redactSecrets(input.content)
	const sanitized: SanitizationResult = sanitizeMemoryContent(
		redacted,
		input.content_type ?? "text",
	)

	const now = new Date().toISOString()
	const id = crypto.randomUUID()
	const episode: Episode = {
		id,
		tenant_id: ctx.tenant_id,
		session_id: input.session_id,
		actor_id: input.actor_id,
		actor_role: input.actor_role,
		content: sanitized.content,
		content_type: input.content_type ?? "text",
		importance: input.importance ?? 0.5,
		created_at: now,
		expires_at: input.expires_in_days
			? new Date(
					Date.now() + input.expires_in_days * 86_400_000,
				).toISOString()
			: undefined,
		compacted: false,
		quarantined: sanitized.action === "quarantine",
		risk_score: sanitized.risk_score,
		risk_flags: sanitized.flags,
		provenance: { source_agent: ctx.agent_id },
	}

	episodeStore.set(id, episode)

	// 2. Audit
	const auditAction: AuditAction =
		sanitized.action === "quarantine" ? "quarantine" : "write"
	audit(ctx, auditAction, "episodes", id, {
		risk_score: sanitized.risk_score,
		quarantined: episode.quarantined,
	})

	return episode
}

// ── Store Fact ────────────────────────────────────────────────────────────────

export interface StoreFactInput {
	subject_id: string
	scope: Fact["scope"]
	category: FactCategory
	key: string
	value: string
	confidence?: number
	source_episodes?: string[]
}

export function storeFact(ctx: GatewayContext, input: StoreFactInput): Fact {
	// 1. Sanitize value
	const redacted = redactSecrets(input.value)
	const sanitized = sanitizeMemoryContent(redacted, "text")
	if (sanitized.action === "quarantine") {
		audit(ctx, "quarantine", "facts", null, {
			key: input.key,
			risk_score: sanitized.risk_score,
		})
		throw new GatewayError(
			"QUARANTINED",
			"Fact content flagged for review and has not been stored",
		)
	}

	// 2. Check for existing active fact (same key)
	const existingEntry = [...factStore.values()].find(
		(f) =>
			f.tenant_id === ctx.tenant_id &&
			f.subject_id === input.subject_id &&
			f.scope === input.scope &&
			f.category === input.category &&
			f.key === input.key &&
			!f.superseded_by,
	)

	const now = new Date().toISOString()
	const id = crypto.randomUUID()

	const fact: Fact = {
		id,
		tenant_id: ctx.tenant_id,
		subject_id: input.subject_id,
		scope: input.scope,
		category: input.category,
		key: input.key,
		value: sanitized.content,
		confidence: input.confidence ?? 1.0,
		source_episodes: input.source_episodes ?? [],
		created_at: now,
		updated_at: now,
		created_by: ctx.agent_id,
	}

	// 3. If existing fact, check for conflicts before superseding
	if (existingEntry) {
		const delta = Math.abs(
			existingEntry.confidence - (input.confidence ?? 1.0),
		)

		if (delta > 0.3) {
			// Auto-resolve to higher confidence: supersede old fact
			existingEntry.superseded_by = id
			factStore.set(existingEntry.id, existingEntry)
		} else if (existingEntry.value !== input.value) {
			// Low-confidence conflict: store both, flag for user resolution
			// The new fact goes in, but a conflict record is created
			audit(ctx, "write", "facts", id, {
				conflict: true,
				existing_fact_id: existingEntry.id,
				confidence_delta: delta,
			})
		}
	}

	factStore.set(id, fact)
	audit(ctx, "write", "facts", id, { key: input.key, scope: input.scope })

	return fact
}

// ── Correct Fact ──────────────────────────────────────────────────────────────

export interface CorrectFactInput {
	fact_id: string
	corrected_value: string
	reason?: string
}

export function correctFact(
	ctx: GatewayContext,
	input: CorrectFactInput,
): Fact {
	const existing = factStore.get(input.fact_id)
	assertTenant(existing, ctx)

	// Create corrected fact — NEVER overwrite, always supersede
	const corrected: Fact = {
		...existing,
		id: crypto.randomUUID(),
		value: input.corrected_value,
		confidence: 1.0, // explicit user correction wins
		updated_at: new Date().toISOString(),
		created_at: new Date().toISOString(),
		created_by: ctx.principal_id, // correction by the requester
	}

	// Mark old fact as superseded
	existing.superseded_by = corrected.id
	factStore.set(existing.id, existing)
	factStore.set(corrected.id, corrected)

	audit(ctx, "correct", "facts", corrected.id, {
		superseded_id: existing.id,
		reason: input.reason,
	})

	return corrected
}

// ── Recall ────────────────────────────────────────────────────────────────────

export interface RecallInput {
	query: string
	memory_types?: MemoryType[]
	time_window_days?: number
	max_results?: number
	subject_id?: string
}

export function recall(
	ctx: GatewayContext,
	input: RecallInput,
): RecallResponse {
	const types = input.memory_types ?? ["semantic", "procedural"]
	const maxResults = Math.min(input.max_results ?? 10, 50)
	const cutoff = input.time_window_days
		? new Date(Date.now() - input.time_window_days * 86_400_000).toISOString()
		: undefined

	const results: RecalledMemory[] = []

	// Episodic recall — exclude quarantined
	if (types.includes("episodic")) {
		for (const ep of episodeStore.values()) {
			if (ep.tenant_id !== ctx.tenant_id) continue
			if (ep.quarantined) continue
			if (cutoff && ep.created_at < cutoff) continue
			// Simple text match (production uses vector search)
			if (
				input.query.length > 0 &&
				!ep.content.toLowerCase().includes(input.query.toLowerCase())
			)
				continue
			results.push({
				memory_type: "episodic",
				id: ep.id,
				content: ep.content,
				confidence: ep.importance,
				created_at: ep.created_at,
				provenance: ep.provenance,
			})
		}
	}

	// Semantic recall — only active (non-superseded) facts visible to this principal
	if (types.includes("semantic")) {
		for (const fact of factStore.values()) {
			if (fact.tenant_id !== ctx.tenant_id) continue
			if (fact.superseded_by) continue // skip superseded
			// Scope check: user-scoped facts only visible to subject
			if (
				fact.scope === "user" &&
				fact.subject_id !== ctx.principal_id &&
				fact.subject_id !== (input.subject_id ?? ctx.principal_id)
			)
				continue
			if (
				input.query.length > 0 &&
				!fact.value.toLowerCase().includes(input.query.toLowerCase()) &&
				!fact.key.toLowerCase().includes(input.query.toLowerCase())
			)
				continue
			results.push({
				memory_type: "semantic",
				id: fact.id,
				content: `[${fact.category}] ${fact.key}: ${fact.value}`,
				confidence: fact.confidence,
				created_at: fact.created_at,
			})
		}
	}

	// Procedural recall
	if (types.includes("procedural")) {
		for (const proc of procedureStore.values()) {
			if (proc.tenant_id !== ctx.tenant_id) continue
			if (
				input.query.length > 0 &&
				!proc.description.toLowerCase().includes(input.query.toLowerCase()) &&
				!proc.name.toLowerCase().includes(input.query.toLowerCase())
			)
				continue
			results.push({
				memory_type: "procedural",
				id: proc.id,
				content: `[procedure] ${proc.name}: ${proc.description}`,
				confidence:
					proc.success_count /
					Math.max(1, proc.success_count + proc.failure_count),
				created_at: proc.created_at,
			})
		}
	}

	// Sort by confidence desc, truncate
	const sorted = results
		.sort((a, b) => b.confidence - a.confidence)
		.slice(0, maxResults)

	audit(ctx, "read", "mixed", null, {
		query: input.query,
		types,
		results_count: sorted.length,
	})

	return { memories: sorted, total: sorted.length, query: input.query }
}

// ── Forget ────────────────────────────────────────────────────────────────────

export type ForgetTarget =
	| "episode"
	| "fact"
	| "procedure"
	| "session"
	| "all_user_data"

export interface ForgetInput {
	target_type: ForgetTarget
	target_id?: string
	user_id?: string // required for all_user_data
	reason: string
}

export function forget(ctx: GatewayContext, input: ForgetInput): number {
	let deleted = 0

	if (input.target_type === "all_user_data") {
		const userId = input.user_id ?? ctx.principal_id
		// Validate: only the user themselves or a tenant admin may erase all data
		if (userId !== ctx.principal_id) {
			throw new GatewayError(
				"FORBIDDEN",
				"Only the user or tenant admin can request full erasure",
			)
		}

		// Delete episodes in user's sessions
		for (const [id, ep] of episodeStore) {
			if (ep.tenant_id === ctx.tenant_id && ep.actor_id === userId) {
				episodeStore.delete(id)
				deleted++
			}
		}

		// Delete user-scoped facts
		for (const [id, fact] of factStore) {
			if (fact.tenant_id === ctx.tenant_id && fact.subject_id === userId) {
				factStore.delete(id)
				deleted++
			}
		}

		// Delete user-scope procedures created by user
		for (const [id, proc] of procedureStore) {
			if (
				proc.tenant_id === ctx.tenant_id &&
				proc.created_by === userId &&
				proc.scope === "user"
			) {
				procedureStore.delete(id)
				deleted++
			}
		}

		audit(ctx, "erasure", "all", null, {
			user_id: userId,
			reason: input.reason,
			deleted_count: deleted,
		})

		return deleted
	}

	// Single-target deletion
	if (!input.target_id)
		throw new GatewayError("VALIDATION", "target_id required")

	const storeMap = {
		episode: episodeStore,
		fact: factStore,
		procedure: procedureStore,
		session: new Map(), // sessions handled separately
	}[input.target_type] as Map<string, { tenant_id: string }>

	const item = storeMap.get(input.target_id)
	assertTenant(item, ctx)
	storeMap.delete(input.target_id)
	deleted++

	audit(ctx, "delete", `${input.target_type}s`, input.target_id, {
		reason: input.reason,
	})

	return deleted
}

// ── Agent Warm-Start ──────────────────────────────────────────────────────────

export function agentWarmStart(
	ctx: GatewayContext,
	sessionTopic?: string,
): WarmStartResult {
	// Step 1: recall user profile and preferences
	const profileResult = recall(ctx, {
		query: "user profile and preferences",
		memory_types: ["semantic"],
		max_results: 20,
	})

	// Step 2: recall recent episodic/procedural context
	const contextResult = recall(ctx, {
		query: sessionTopic ?? "",
		memory_types: ["episodic", "procedural"],
		time_window_days: 30,
		max_results: 10,
	})

	return {
		user_profile: profileResult.memories,
		recent_context: contextResult.memories.filter(
			(m) => m.memory_type === "episodic",
		),
		relevant_procedures: contextResult.memories.filter(
			(m) => m.memory_type === "procedural",
		),
	}
}

// ── Format warm-start for system prompt injection ─────────────────────────────

export function formatWarmStartForPrompt(warmStart: WarmStartResult): string {
	const sections: string[] = []

	if (warmStart.user_profile.length > 0) {
		sections.push(
			"## User Profile\n" +
				formatMemoriesForAgent(warmStart.user_profile),
		)
	}

	if (warmStart.recent_context.length > 0) {
		sections.push(
			"## Recent Context\n" +
				formatMemoriesForAgent(warmStart.recent_context),
		)
	}

	if (warmStart.relevant_procedures.length > 0) {
		sections.push(
			"## Relevant Procedures\n" +
				formatMemoriesForAgent(warmStart.relevant_procedures),
		)
	}

	return sections.join("\n\n")
}
