// =============================================================
// Fleet Memory Prototype — MCP Tool Definitions
// Registers the 6 fleet memory tools on an McpServer instance.
// =============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { GatewayContext } from "./types"
import type { MemoryStore } from "./store"
import {
	storeEpisode,
	storeFact,
	correctFact,
	recall,
	forget,
	agentWarmStart,
	formatWarmStartForPrompt,
	GatewayError,
} from "./gateway"
import { formatMemoriesForAgent } from "./sanitization"

// ── Helper ────────────────────────────────────────────────────────────────────

function errorResponse(err: unknown) {
	const message =
		err instanceof GatewayError
			? `[${err.code}] ${err.message}`
			: err instanceof Error
				? err.message
				: "An unexpected error occurred"
	return {
		content: [{ type: "text" as const, text: message }],
		isError: true,
	}
}

// ── Tool registration ─────────────────────────────────────────────────────────

/**
 * Register all Fleet Memory tools on the given McpServer.
 * @param server  - The McpServer instance
 * @param getCtx  - Returns the current GatewayContext for the request
 * @param store   - The MemoryStore backend (DurableObjectStore in production)
 */
export function registerFleetMemoryTools(
	server: McpServer,
	getCtx: () => GatewayContext,
	store: MemoryStore,
): void {
	// ── memory_recall ─────────────────────────────────────────────────────────

	server.registerTool(
		"memory_recall",
		{
			description:
				"Retrieve relevant memories for the current context. Returns episodic, semantic, and procedural memories ranked by relevance. Use this at the start of any conversation to load user context.",
			inputSchema: z.object({
				query: z
					.string()
					.min(1)
					.max(1000)
					.describe("Natural language query describing what to remember"),
				memory_types: z
					.array(z.enum(["episodic", "semantic", "procedural"]))
					.optional()
					.default(["semantic", "procedural"])
					.describe("Which memory tiers to search"),
				time_window: z
					.string()
					.optional()
					.describe(
						"ISO 8601 duration, e.g. P7D for last 7 days. Applies to episodic only.",
					),
				max_results: z
					.number()
					.int()
					.min(1)
					.max(50)
					.optional()
					.default(10)
					.describe("Maximum number of memories to return"),
			}),
		},
		// @ts-expect-error - zod inference vs MCP SDK types
		async (args: {
			query: string
			memory_types?: Array<"episodic" | "semantic" | "procedural">
			time_window?: string
			max_results?: number
		}) => {
			try {
				const ctx = getCtx()

				// Parse ISO 8601 duration P7D → days
				let time_window_days: number | undefined
				if (args.time_window) {
					const match = args.time_window.match(/P(\d+)D/i)
					if (match) time_window_days = Number.parseInt(match[1], 10)
				}

				const response = await recall(ctx, store, {
					query: args.query,
					memory_types: args.memory_types,
					time_window_days,
					max_results: args.max_results,
				})

				if (response.memories.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No memories found for query: "${args.query}"`,
							},
						],
					}
				}

				return {
					content: [
						{
							type: "text" as const,
							text: formatMemoriesForAgent(response.memories),
						},
					],
				}
			} catch (err) {
				return errorResponse(err)
			}
		},
	)

	// ── memory_store_episode ──────────────────────────────────────────────────

	server.registerTool(
		"memory_store_episode",
		{
			description:
				"Record an episodic memory from the current conversation turn. Use this to log important events, tool calls, or significant user statements for future recall.",
			inputSchema: z.object({
				content: z
					.string()
					.min(1)
					.max(200_000)
					.describe("The content of this episode to remember"),
				content_type: z
					.enum(["text", "tool_call", "tool_result", "event"])
					.optional()
					.default("text")
					.describe("The nature of this episode"),
				importance: z
					.number()
					.min(0)
					.max(1)
					.optional()
					.default(0.5)
					.describe(
						"Agent's assessment of importance for long-term retention (0=low, 1=critical)",
					),
				session_id: z
					.string()
					.uuid()
					.optional()
					.describe("Session UUID — generated if not supplied"),
			}),
		},
		// @ts-expect-error - zod inference vs MCP SDK types
		async (args: {
			content: string
			content_type?: "text" | "tool_call" | "tool_result" | "event"
			importance?: number
			session_id?: string
		}) => {
			try {
				const ctx = getCtx()
				const episode = await storeEpisode(ctx, store, {
					session_id: args.session_id ?? ctx.session_id ?? crypto.randomUUID(),
					actor_id: ctx.principal_id,
					actor_role: "agent",
					content: args.content,
					content_type: args.content_type ?? "text",
					importance: args.importance ?? 0.5,
				})

				if (episode.quarantined) {
					return {
						content: [
							{
								type: "text" as const,
								text: "Episode stored but flagged for review. It will not be served to other agents until reviewed.",
							},
						],
					}
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `Episode recorded. id=${episode.id}`,
						},
					],
				}
			} catch (err) {
				return errorResponse(err)
			}
		},
	)

	// ── memory_store_fact ─────────────────────────────────────────────────────

	server.registerTool(
		"memory_store_fact",
		{
			description:
				"Record or update a semantic fact about the user or organization. Facts persist across sessions and are shared with all agents serving the same user.",
			inputSchema: z.object({
				category: z
					.enum([
						"preference",
						"identity",
						"relationship",
						"decision",
						"context",
					])
					.describe("Category of the fact"),
				key: z
					.string()
					.min(1)
					.max(256)
					.describe(
						"Human-readable fact key, e.g. 'bible_translation_preference'",
					),
				value: z
					.string()
					.min(1)
					.max(10_000)
					.describe("The fact value"),
				confidence: z
					.number()
					.min(0)
					.max(1)
					.optional()
					.default(0.9)
					.describe("Confidence level for this fact (0–1)"),
				scope: z
					.enum(["user", "org"])
					.optional()
					.default("user")
					.describe(
						"Visibility scope: user (private to this user) or org (visible to all agents in tenant)",
					),
			}),
		},
		// @ts-expect-error - zod inference vs MCP SDK types
		async (args: {
			category:
				| "preference"
				| "identity"
				| "relationship"
				| "decision"
				| "context"
			key: string
			value: string
			confidence?: number
			scope?: "user" | "org"
		}) => {
			try {
				const ctx = getCtx()
				const fact = await storeFact(ctx, store, {
					subject_id: ctx.principal_id,
					scope: args.scope ?? "user",
					category: args.category,
					key: args.key,
					value: args.value,
					confidence: args.confidence ?? 0.9,
				})
				return {
					content: [
						{
							type: "text" as const,
							text: `Fact stored. id=${fact.id} key="${fact.key}" scope=${fact.scope}`,
						},
					],
				}
			} catch (err) {
				return errorResponse(err)
			}
		},
	)

	// ── memory_correct ────────────────────────────────────────────────────────

	server.registerTool(
		"memory_correct",
		{
			description:
				"Correct or supersede an existing fact. Creates a new fact with the corrected value and marks the old one as superseded. The full correction chain is preserved for audit.",
			inputSchema: z.object({
				fact_id: z.string().uuid().describe("UUID of the fact to correct"),
				corrected_value: z
					.string()
					.min(1)
					.max(10_000)
					.describe("The corrected fact value"),
				reason: z
					.string()
					.max(1000)
					.optional()
					.describe("Reason for the correction"),
			}),
		},
		// @ts-expect-error - zod inference vs MCP SDK types
		async (args: {
			fact_id: string
			corrected_value: string
			reason?: string
		}) => {
			try {
				const ctx = getCtx()
				const corrected = await correctFact(ctx, store, {
					fact_id: args.fact_id,
					corrected_value: args.corrected_value,
					reason: args.reason,
				})
				return {
					content: [
						{
							type: "text" as const,
							text: `Fact corrected. new_id=${corrected.id} supersedes=${args.fact_id}`,
						},
					],
				}
			} catch (err) {
				return errorResponse(err)
			}
		},
	)

	// ── memory_forget ─────────────────────────────────────────────────────────

	server.registerTool(
		"memory_forget",
		{
			description:
				"Delete a specific memory or erase all your memories (GDPR/CCPA right-to-erasure). Erasure is complete and cascading for all_user_data.",
			inputSchema: z.object({
				target_type: z
					.enum([
						"episode",
						"fact",
						"procedure",
						"session",
						"all_user_data",
					])
					.describe("What to delete"),
				target_id: z
					.string()
					.uuid()
					.optional()
					.describe(
						"UUID of the specific record to delete (omit for all_user_data)",
					),
				reason: z
					.string()
					.min(1)
					.max(1000)
					.describe("Reason for deletion (required for audit log)"),
			}),
		},
		// @ts-expect-error - zod inference vs MCP SDK types
		async (args: {
			target_type:
				| "episode"
				| "fact"
				| "procedure"
				| "session"
				| "all_user_data"
			target_id?: string
			reason: string
		}) => {
			try {
				const ctx = getCtx()
				const deleted = await forget(ctx, store, {
					target_type: args.target_type,
					target_id: args.target_id,
					reason: args.reason,
				})
				return {
					content: [
						{
							type: "text" as const,
							text:
								args.target_type === "all_user_data"
									? `Erasure complete. ${deleted} records deleted and audit entry created.`
									: `Deleted ${deleted} record(s). id=${args.target_id}`,
						},
					],
				}
			} catch (err) {
				return errorResponse(err)
			}
		},
	)

	// ── memory_warm_start ─────────────────────────────────────────────────────

	server.registerTool(
		"memory_warm_start",
		{
			description:
				"Load user profile, recent context, and relevant procedures for the current session. Call this at the beginning of each conversation to prime the agent with persistent memory.",
			inputSchema: z.object({
				session_topic: z
					.string()
					.max(500)
					.optional()
					.describe(
						"Brief description of the current session topic for context-specific recall",
					),
			}),
		},
		// @ts-expect-error - zod inference vs MCP SDK types
		async (args: { session_topic?: string }) => {
			try {
				const ctx = getCtx()
				const warmStart = await agentWarmStart(ctx, store, args.session_topic)
				const formatted = formatWarmStartForPrompt(warmStart)

				if (!formatted) {
					return {
						content: [
							{
								type: "text" as const,
								text: "No prior memories found for this user. Starting fresh.",
							},
						],
					}
				}

				return {
					content: [{ type: "text" as const, text: formatted }],
				}
			} catch (err) {
				return errorResponse(err)
			}
		},
	)
}
