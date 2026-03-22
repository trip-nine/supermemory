// =============================================================
// Fleet Memory Prototype — Compaction Engine
// Async background process: episode batches → durable semantic facts
// Designed to run as a Supabase Edge Function on a cron schedule.
// =============================================================

import type {
	Episode,
	Fact,
	ExtractedFact,
	CompactionResult,
	GatewayContext,
	FactCategory,
} from "./types"

// ── LLM fact-extraction prompt ────────────────────────────────────────────────

export const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction engine. Given a batch of conversation episodes, extract durable facts that should be remembered long-term.

Rules:
1. Only extract facts the user explicitly stated or clearly implied.
2. Do NOT infer opinions, emotions, or intentions beyond what was said.
3. Each fact must have: category, key, value, confidence (0-1).
4. If a fact contradicts a known existing fact, flag it as a correction with the existing fact's key.
5. Prefer specific facts over vague ones.
6. Never extract: passwords, API keys, SSNs, credit card numbers, or other secrets.

Valid categories: preference, identity, relationship, decision, context

Output a JSON array only, no additional text:
[
  {
    "category": "preference",
    "key": "bible_translation",
    "value": "Prefers ESV and NKJV",
    "confidence": 0.95,
    "is_correction": false,
    "existing_key": null
  }
]`

// ── Conflict resolution constants ─────────────────────────────────────────────

/** If confidence delta between conflicting facts > this threshold, auto-resolve. */
const AUTO_RESOLVE_THRESHOLD = 0.3

// ── Conflict detection ────────────────────────────────────────────────────────

export interface FactConflict {
	fact_a_id: string
	fact_b_id: string
	key: string
	value_a: string
	value_b: string
	confidence_a: number
	confidence_b: number
	confidence_delta: number
}

export function detectConflicts(facts: Fact[]): FactConflict[] {
	const conflicts: FactConflict[] = []
	const grouped = new Map<string, Fact[]>()

	// Group active facts by (tenant_id, subject_id, scope, category, key).
	// Scope and category are part of the uniqueness constraint — a user-scoped
	// preference and an org-scoped preference with the same key are NOT conflicts.
	for (const fact of facts) {
		if (fact.superseded_by) continue
		const groupKey = `${fact.tenant_id}:${fact.subject_id}:${fact.scope}:${fact.category}:${fact.key}`
		const group = grouped.get(groupKey) ?? []
		group.push(fact)
		grouped.set(groupKey, group)
	}

	for (const group of grouped.values()) {
		if (group.length < 2) continue
		for (let i = 0; i < group.length; i++) {
			for (let j = i + 1; j < group.length; j++) {
				const a = group[i]
				const b = group[j]
				if (a.value !== b.value) {
					conflicts.push({
						fact_a_id: a.id,
						fact_b_id: b.id,
						key: a.key,
						value_a: a.value,
						value_b: b.value,
						confidence_a: a.confidence,
						confidence_b: b.confidence,
						confidence_delta: Math.abs(a.confidence - b.confidence),
					})
				}
			}
		}
	}

	return conflicts
}

// ── Conflict resolution ───────────────────────────────────────────────────────

export interface ConflictResolution {
	winner_id: string
	loser_id: string
	method: "auto_confidence" | "held_for_user"
}

export function resolveConflict(conflict: FactConflict): ConflictResolution {
	if (conflict.confidence_delta > AUTO_RESOLVE_THRESHOLD) {
		// Auto-resolve: higher confidence wins
		const winnerId =
			conflict.confidence_a >= conflict.confidence_b
				? conflict.fact_a_id
				: conflict.fact_b_id
		const loserId =
			winnerId === conflict.fact_a_id
				? conflict.fact_b_id
				: conflict.fact_a_id
		return { winner_id: winnerId, loser_id: loserId, method: "auto_confidence" }
	}

	// Low delta: hold both, surface to user on next interaction
	// Return fact_a as the "preferred" but mark as pending resolution
	return {
		winner_id: conflict.fact_a_id,
		loser_id: conflict.fact_b_id,
		method: "held_for_user",
	}
}

// ── Compaction pipeline ───────────────────────────────────────────────────────

/**
 * The compaction engine processes uncompacted episodes for a tenant and
 * extracts durable semantic facts.
 *
 * In production this runs as a Supabase Edge Function on a cron schedule.
 * The extractFacts function must be provided by the caller (allows injecting
 * different LLM backends without coupling this module to a specific client).
 */
export async function runCompaction(
	ctx: GatewayContext,
	episodes: Episode[],
	existingFacts: Fact[],
	extractFacts: (
		systemPrompt: string,
		episodeContents: string[],
	) => Promise<ExtractedFact[]>,
	storeFact: (
		ctx: GatewayContext,
		extracted: ExtractedFact,
		subjectId: string,
		sourceEpisodeIds: string[],
	) => Promise<Fact>,
	markEpisodesCompacted: (episodeIds: string[]) => Promise<void>,
): Promise<CompactionResult> {
	const result: CompactionResult = {
		episodes_processed: 0,
		facts_created: 0,
		facts_updated: 0,
		conflicts_flagged: 0,
		errors: [],
	}

	if (episodes.length === 0) return result

	// 1. Group episodes by session for context coherence
	const bySession = new Map<string, Episode[]>()
	for (const ep of episodes) {
		const group = bySession.get(ep.session_id) ?? []
		group.push(ep)
		bySession.set(ep.session_id, group)
	}

	// Track episode IDs that were successfully fully processed.
	// Only these will be marked compacted — failed sessions are excluded.
	const successfulEpisodeIds = new Set<string>()

	// 2. Process each session batch
	for (const [sessionId, sessionEpisodes] of bySession) {
		try {
			const contents = sessionEpisodes
				.sort(
					(a, b) =>
						new Date(a.created_at).getTime() -
						new Date(b.created_at).getTime(),
				)
				.map((ep) => `[${ep.actor_role}] ${ep.content}`)

			// 3. Extract facts via LLM
			const extracted = await extractFacts(EXTRACTION_SYSTEM_PROMPT, contents)

			// 4. Merge into fact store
			let sessionHadError = false
			for (const ef of extracted) {
				const subjectId = sessionEpisodes[0].actor_id
				try {
					const existing = existingFacts.find(
						(f) =>
							f.key === (ef.existing_key ?? ef.key) &&
							f.subject_id === subjectId &&
							!f.superseded_by,
					)

					if (ef.is_correction && existing) {
						await storeFact(
							ctx,
							{ ...ef, key: existing.key, is_correction: true },
							subjectId,
							sessionEpisodes.map((e) => e.id),
						)
						result.facts_updated++
					} else {
						await storeFact(
							ctx,
							ef,
							subjectId,
							sessionEpisodes.map((e) => e.id),
						)
						result.facts_created++
					}
				} catch (err) {
					sessionHadError = true
					result.errors.push(
						`Fact store error for key "${ef.key}": ${err instanceof Error ? err.message : String(err)}`,
					)
				}
			}

			// 5. Detect conflicts in updated facts
			const conflicts = detectConflicts(existingFacts)
			result.conflicts_flagged += conflicts.filter(
				(c) => resolveConflict(c).method === "held_for_user",
			).length

			// Only mark episodes as compacted if ALL facts for this session were stored
			if (!sessionHadError) {
				result.episodes_processed += sessionEpisodes.length
				for (const ep of sessionEpisodes) {
					successfulEpisodeIds.add(ep.id)
				}
			}
		} catch (err) {
			result.errors.push(
				`Session ${sessionId} compaction error: ${err instanceof Error ? err.message : String(err)}`,
			)
			continue
		}
	}

	// 6. Mark episodes as compacted ONLY after facts are durably written.
	// Invariant: compacted=true is never set unless the corresponding facts
	// are confirmed stored (transaction semantics enforced by successfulEpisodeIds).
	if (successfulEpisodeIds.size > 0) {
		await markEpisodesCompacted([...successfulEpisodeIds])
	}

	return result
}

// ── Retention cleanup ─────────────────────────────────────────────────────────

/**
 * Returns default retention settings for a tenant.
 * In production, per-tenant settings override these defaults.
 */
export const DEFAULT_RETENTION = {
	episodic: {
		raw_retention_days: 90,
		compacted_retention_days: 365,
		auto_compact_after_hours: 24,
	},
	semantic: {
		retention: "indefinite" as const,
		review_cycle_days: 180,
	},
	procedural: {
		retention: "indefinite" as const,
		deprecate_after_failures: 5,
	},
	audit_log: {
		retention_days: 730,
	},
}
