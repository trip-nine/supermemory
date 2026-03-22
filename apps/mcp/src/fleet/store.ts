// =============================================================
// Fleet Memory Prototype — MemoryStore Interface
// Decouples the gateway from its storage backend.
// Swap InMemoryStore (tests / ephemeral prototype) for
// DurableObjectStore (CF Workers) or SupabaseStore (production).
// =============================================================

import type { Episode, Fact, Procedure } from "./types"

// ── Audit entry (stored separately from Episode/Fact/Procedure) ───────────────

export interface AuditEntry {
	tenant_id: string
	principal_id: string
	action: string
	target_table: string
	target_id: string | null
	detail: Record<string, unknown>
	created_at: string
}

// ── Interface ─────────────────────────────────────────────────────────────────

export interface MemoryStore {
	// Episodes
	getEpisode(id: string): Promise<Episode | undefined>
	setEpisode(episode: Episode): Promise<void>
	deleteEpisode(id: string): Promise<void>
	/** Returns ALL episodes owned by this store (caller filters by tenant). */
	allEpisodes(): Promise<Episode[]>

	// Facts
	getFact(id: string): Promise<Fact | undefined>
	setFact(fact: Fact): Promise<void>
	deleteFact(id: string): Promise<void>
	/** Returns ALL facts owned by this store (caller filters by tenant). */
	allFacts(): Promise<Fact[]>

	// Procedures
	getProcedure(id: string): Promise<Procedure | undefined>
	setProcedure(proc: Procedure): Promise<void>
	deleteProcedure(id: string): Promise<void>
	/** Returns ALL procedures owned by this store (caller filters by tenant). */
	allProcedures(): Promise<Procedure[]>

	// Audit (append-only — never delete)
	appendAudit(entry: AuditEntry): Promise<void>
}

// ── InMemoryStore — ephemeral, good for tests and local dev ───────────────────

export class InMemoryStore implements MemoryStore {
	private episodes = new Map<string, Episode>()
	private facts = new Map<string, Fact>()
	private procedures = new Map<string, Procedure>()
	private auditLog: AuditEntry[] = []

	async getEpisode(id: string) {
		return this.episodes.get(id)
	}
	async setEpisode(ep: Episode) {
		this.episodes.set(ep.id, ep)
	}
	async deleteEpisode(id: string) {
		this.episodes.delete(id)
	}
	async allEpisodes() {
		return [...this.episodes.values()]
	}

	async getFact(id: string) {
		return this.facts.get(id)
	}
	async setFact(fact: Fact) {
		this.facts.set(fact.id, fact)
	}
	async deleteFact(id: string) {
		this.facts.delete(id)
	}
	async allFacts() {
		return [...this.facts.values()]
	}

	async getProcedure(id: string) {
		return this.procedures.get(id)
	}
	async setProcedure(proc: Procedure) {
		this.procedures.set(proc.id, proc)
	}
	async deleteProcedure(id: string) {
		this.procedures.delete(id)
	}
	async allProcedures() {
		return [...this.procedures.values()]
	}

	async appendAudit(entry: AuditEntry) {
		this.auditLog.push(entry)
	}
}

// ── DurableObjectStore — persistent via Cloudflare DO storage ─────────────────
// Each Durable Object instance stores memory for one user/tenant.
// Key scheme:
//   episode:{id}    → Episode
//   fact:{id}       → Fact
//   procedure:{id}  → Procedure
//   audit:{ts}_{rnd} → AuditEntry  (append-only; never listed for performance)

export class DurableObjectStore implements MemoryStore {
	constructor(private storage: DurableObjectStorage) {}

	private async listPrefix<T>(prefix: string): Promise<T[]> {
		const map = await this.storage.list<T>({ prefix })
		return [...map.values()]
	}

	async getEpisode(id: string) {
		return this.storage.get<Episode>(`episode:${id}`)
	}
	async setEpisode(ep: Episode) {
		await this.storage.put(`episode:${ep.id}`, ep)
	}
	async deleteEpisode(id: string) {
		await this.storage.delete(`episode:${id}`)
	}
	async allEpisodes() {
		return this.listPrefix<Episode>("episode:")
	}

	async getFact(id: string) {
		return this.storage.get<Fact>(`fact:${id}`)
	}
	async setFact(fact: Fact) {
		await this.storage.put(`fact:${fact.id}`, fact)
	}
	async deleteFact(id: string) {
		await this.storage.delete(`fact:${id}`)
	}
	async allFacts() {
		return this.listPrefix<Fact>("fact:")
	}

	async getProcedure(id: string) {
		return this.storage.get<Procedure>(`procedure:${id}`)
	}
	async setProcedure(proc: Procedure) {
		await this.storage.put(`procedure:${proc.id}`, proc)
	}
	async deleteProcedure(id: string) {
		await this.storage.delete(`procedure:${id}`)
	}
	async allProcedures() {
		return this.listPrefix<Procedure>("procedure:")
	}

	async appendAudit(entry: AuditEntry) {
		// ISO timestamp prefix preserves chronological ordering on list().
		// UUID suffix guarantees uniqueness even under concurrent writes.
		const key = `audit:${new Date().toISOString()}_${crypto.randomUUID()}`
		await this.storage.put(key, entry)
	}
}
