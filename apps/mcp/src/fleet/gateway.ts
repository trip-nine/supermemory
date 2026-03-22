// =============================================================
// Fleet Memory Prototype — Memory Gateway
// Single entry point for all agent memory operations.
// Pipeline: Auth → Tenant Resolution → Policy Check → Sanitize → Execute → Audit → Response
//
// All functions are async and accept an injected MemoryStore so the
// storage backend can be swapped (InMemoryStore → DurableObjectStore →
// SupabaseStore) without touching this module.
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
import type { MemoryStore } from "./store"
import {
	sanitizeMemoryContent,
	formatMemoriesForAgent,
	redactSecrets,
} from "./sanitization"

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

// ── Audit helper (async, append-only) ────────────────────────────────────────

async function audit(
	ctx: GatewayContext,
	store: MemoryStore,
	action: AuditAction,
	target_table: string,
	target_id: string | null,
	detail: Record<string, unknown> = {},
): Promise<void> {
	await store.appendAudit({
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
): asserts item is T {
	if (!item) throw new GatewayError("NOT_FOUND", "Memory not found")
	if (item.tenant_id !== ctx.tenant_id)
		throw new GatewayError("FORBIDDEN", "Cross-tenant access denied")
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

export async function storeEpisode(
	ctx: GatewayContext,
	store: MemoryStore,
	input: StoreEpisodeInput,
): Promise<Episode> {
	// 1. Detect injection BEFORE redaction so patterns aren't hidden by redaction
	const sanitized: SanitizationResult = sanitizeMemoryContent(
		input.content,
		input.content_type ?? "text",
	)
	// 2. Redact secrets from the content that will be stored
	const safeContent = redactSecrets(sanitized.content)

	const id = crypto.randomUUID()
	const episode: Episode = {
		id,
		tenant_id: ctx.tenant_id,
		session_id: input.session_id,
		actor_id: input.actor_id,
		actor_role: input.actor_role,
		content: safeContent,
		content_type: input.content_type ?? "text",
		importance: input.importance ?? 0.5,
		created_at: new Date().toISOString(),
		expires_at: input.expires_in_days
			? new Date(
					Date.now() + input.expires_in_days * 86_400_000,
				).toISOString()
			: undefined,
		compacted: false,
		quarantined: sanitized.action === "quarantine",
		// Don't store the exact risk_score/flags to avoid leaking detection thresholds
		risk_score: sanitized.risk_score >= 0.5 ? 1 : 0,
		risk_flags: sanitized.action === "quarantine" ? ["flagged"] : [],
		provenance: { source_agent: ctx.agent_id },
	}

	await store.setEpisode(episode)

	// Audit: record quarantine or normal write, but never the risk_score detail
	const auditAction: AuditAction =
		sanitized.action === "quarantine" ? "quarantine" : "write"
	await audit(ctx, store, auditAction, "episodes", id, {
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

export async function storeFact(
	ctx: GatewayContext,
	store: MemoryStore,
	input: StoreFactInput,
): Promise<Fact> {
	// 1. Detect injection BEFORE redaction
	const sanitized = sanitizeMemoryContent(input.value, "text")
	if (sanitized.action === "quarantine") {
		await audit(ctx, store, "quarantine", "facts", null, { key: input.key })
		throw new GatewayError(
			"QUARANTINED",
			"Fact content flagged for review and has not been stored",
		)
	}
	const safeValue = redactSecrets(sanitized.content)

	// 2. Check for existing active fact (same key in same scope+category)
	const allFacts = await store.allFacts()
	const existingEntry = allFacts.find(
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
		value: safeValue,
		confidence: input.confidence ?? 1.0,
		source_episodes: input.source_episodes ?? [],
		created_at: now,
		updated_at: now,
		created_by: ctx.agent_id,
	}

	// 3. Handle conflicts before inserting
	if (existingEntry) {
		const newConfidence = input.confidence ?? 1.0
		const delta = Math.abs(existingEntry.confidence - newConfidence)

		if (delta > 0.3) {
			// Auto-resolve: higher confidence wins; mark old as superseded
			existingEntry.superseded_by = id
			await store.setFact(existingEntry)
			// Audit the supersede — previously missing
			await audit(ctx, store, "correct", "facts", existingEntry.id, {
				superseded_by: id,
				reason: "auto_resolved:confidence_delta",
				confidence_delta: delta,
			})
		} else if (existingEntry.value !== input.value) {
			// Low-confidence conflict: store both and flag for user resolution
			await audit(ctx, store, "write", "facts", id, {
				conflict: true,
				existing_fact_id: existingEntry.id,
				confidence_delta: delta,
			})
		}
	}

	await store.setFact(fact)
	await audit(ctx, store, "write", "facts", id, {
		key: input.key,
		scope: input.scope,
	})

	return fact
}

// ── Correct Fact ──────────────────────────────────────────────────────────────

export interface CorrectFactInput {
	fact_id: string
	corrected_value: string
	reason?: string
}

export async function correctFact(
	ctx: GatewayContext,
	store: MemoryStore,
	input: CorrectFactInput,
): Promise<Fact> {
	const existing = await store.getFact(input.fact_id)
	assertTenant(existing, ctx)

	// Authorization: only the fact's subject, the creating agent, or an admin
	const isSubject = existing.subject_id === ctx.principal_id
	const isCreator = existing.created_by === ctx.agent_id
	const isAdmin = ctx.role === "admin"
	if (!isSubject && !isCreator && !isAdmin) {
		throw new GatewayError(
			"FORBIDDEN",
			"You can only correct facts about yourself or facts your agent created",
		)
	}

	// NEVER overwrite — always create a new fact and mark the old as superseded
	const corrected: Fact = {
		...existing,
		id: crypto.randomUUID(),
		value: input.corrected_value,
		confidence: 1.0, // explicit correction wins unconditionally
		updated_at: new Date().toISOString(),
		created_at: new Date().toISOString(),
		created_by: ctx.principal_id,
		superseded_by: undefined,
	}

	existing.superseded_by = corrected.id
	await store.setFact(existing)
	await store.setFact(corrected)

	await audit(ctx, store, "correct", "facts", corrected.id, {
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
	// subject_id intentionally removed — user-scoped facts are only visible to
	// the principal identified in ctx. Agents cannot cross-read private facts.
}

export async function recall(
	ctx: GatewayContext,
	store: MemoryStore,
	input: RecallInput,
): Promise<RecallResponse> {
	const types = input.memory_types ?? ["semantic", "procedural"]
	const maxResults = Math.min(input.max_results ?? 10, 50)
	const cutoff = input.time_window_days
		? new Date(Date.now() - input.time_window_days * 86_400_000).toISOString()
		: undefined

	const results: RecalledMemory[] = []

	// Episodic — quarantined episodes are never served to agents
	if (types.includes("episodic")) {
		const episodes = await store.allEpisodes()
		for (const ep of episodes) {
			if (ep.tenant_id !== ctx.tenant_id) continue
			if (ep.quarantined) continue
			if (cutoff && ep.created_at < cutoff) continue
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

	// Semantic — only active (non-superseded) facts; user-scope strictly locked to subject
	if (types.includes("semantic")) {
		const facts = await store.allFacts()
		for (const fact of facts) {
			if (fact.tenant_id !== ctx.tenant_id) continue
			if (fact.superseded_by) continue
			// User-scoped facts: only the subject can see them. Period.
			if (fact.scope === "user" && fact.subject_id !== ctx.principal_id) continue
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

	// Procedural
	if (types.includes("procedural")) {
		const procedures = await store.allProcedures()
		for (const proc of procedures) {
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

	const sorted = results
		.sort((a, b) => b.confidence - a.confidence)
		.slice(0, maxResults)

	await audit(ctx, store, "read", "mixed", null, {
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
	reason: string
}

export async function forget(
	ctx: GatewayContext,
	store: MemoryStore,
	input: ForgetInput,
): Promise<number> {
	let deleted = 0

	if (input.target_type === "all_user_data") {
		// Only the principal themselves or a tenant admin can erase all data.
		// The user_id override is removed — admins must impersonate via role, not id.
		if (ctx.role !== "admin" && ctx.role !== "user") {
			throw new GatewayError(
				"FORBIDDEN",
				"Only the user or a tenant admin can request full erasure",
			)
		}
		// Non-admins can only erase their own data
		const targetUserId = ctx.principal_id

		for (const ep of await store.allEpisodes()) {
			if (ep.tenant_id === ctx.tenant_id && ep.actor_id === targetUserId) {
				await store.deleteEpisode(ep.id)
				deleted++
			}
		}
		for (const fact of await store.allFacts()) {
			if (fact.tenant_id === ctx.tenant_id && fact.subject_id === targetUserId) {
				await store.deleteFact(fact.id)
				deleted++
			}
		}
		for (const proc of await store.allProcedures()) {
			if (
				proc.tenant_id === ctx.tenant_id &&
				proc.created_by === targetUserId &&
				proc.scope === "user"
			) {
				await store.deleteProcedure(proc.id)
				deleted++
			}
		}

		await audit(ctx, store, "erasure", "all", null, {
			target_user_id: targetUserId,
			reason: input.reason,
			deleted_count: deleted,
		})

		return deleted
	}

	// Single-target deletion
	if (!input.target_id)
		throw new GatewayError("VALIDATION", "target_id required for non-erasure deletes")

	if (input.target_type === "episode") {
		const ep = await store.getEpisode(input.target_id)
		assertTenant(ep, ctx)
		await store.deleteEpisode(input.target_id)
	} else if (input.target_type === "fact") {
		const fact = await store.getFact(input.target_id)
		assertTenant(fact, ctx)
		await store.deleteFact(input.target_id)
	} else if (input.target_type === "procedure") {
		const proc = await store.getProcedure(input.target_id)
		assertTenant(proc, ctx)
		await store.deleteProcedure(input.target_id)
	} else {
		throw new GatewayError("VALIDATION", `Unsupported target_type: ${input.target_type}`)
	}
	deleted++

	await audit(ctx, store, "delete", `${input.target_type}s`, input.target_id, {
		reason: input.reason,
	})

	return deleted
}

// ── Agent Warm-Start ──────────────────────────────────────────────────────────

export async function agentWarmStart(
	ctx: GatewayContext,
	store: MemoryStore,
	sessionTopic?: string,
): Promise<WarmStartResult> {
	const [profileResult, contextResult] = await Promise.all([
		recall(ctx, store, {
			query: "user profile and preferences",
			memory_types: ["semantic"],
			max_results: 20,
		}),
		recall(ctx, store, {
			query: sessionTopic ?? "",
			memory_types: ["episodic", "procedural"],
			time_window_days: 30,
			max_results: 10,
		}),
	])

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
			"## User Profile\n" + formatMemoriesForAgent(warmStart.user_profile),
		)
	}
	if (warmStart.recent_context.length > 0) {
		sections.push(
			"## Recent Context\n" + formatMemoriesForAgent(warmStart.recent_context),
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
