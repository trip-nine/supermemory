// =============================================================
// Fleet Memory Prototype — Anti-Injection Sanitization Pipeline
// Write-time content sanitization and read-time formatting
// =============================================================

import type { ContentType, SanitizationResult, RecalledMemory } from "./types"

// Patterns that suggest prompt injection attempts
const INJECTION_PATTERNS: RegExp[] = [
	/ignore\s+(previous|all|above)\s+instructions/i,
	/you\s+are\s+now\s+/i,
	/system\s*:\s*/i,
	/<\|.*?\|>/i, // common prompt delimiter attempts
	/\[INST\]/i,
	/###\s*(system|instruction)/i,
	/forget\s+(everything|all|your)/i,
	/\[\/?(SYS|INST|HUMAN|ASSISTANT)\]/i,
	/<\/?s\b/i, // Llama-style special tokens
	/\|im_start\|/i, // ChatML tokens
	/\|im_end\|/i,
	/<\|endoftext\|>/i,
]

// Unicode codepoints/ranges that are suspicious in memory content
const SUSPICIOUS_UNICODE_RANGES: Array<[number, number]> = [
	[0x200b, 0x200f], // Zero-width chars
	[0x202a, 0x202e], // Bidirectional text overrides
	[0x2060, 0x2064], // Invisible operators
	[0xfeff, 0xfeff], // BOM / zero-width no-break space
	[0xe0000, 0xe007f], // Tags block (often used for steganography)
]

/**
 * Check content for suspicious Unicode characters that may hide injections.
 */
function containsSuspiciousUnicode(content: string): boolean {
	for (const char of content) {
		const cp = char.codePointAt(0)
		if (cp === undefined) continue
		for (const [lo, hi] of SUSPICIOUS_UNICODE_RANGES) {
			if (cp >= lo && cp <= hi) return true
		}
	}
	return false
}

/**
 * Sanitize memory content at write time.
 *
 * Returns a SanitizationResult indicating whether to allow or quarantine.
 * Quarantined content is stored but NOT served to agents until reviewed.
 */
export function sanitizeMemoryContent(
	content: string,
	contentType: ContentType,
): SanitizationResult {
	let riskScore = 0.0
	const flags: string[] = []

	// Check injection patterns
	for (const pattern of INJECTION_PATTERNS) {
		if (pattern.test(content)) {
			riskScore += 0.3
			flags.push(`injection_pattern:${pattern.source}`)
		}
	}

	// Check for suspicious Unicode
	if (containsSuspiciousUnicode(content)) {
		riskScore += 0.2
		flags.push("suspicious_unicode")
	}

	// Check for unusual density of special characters (prompt delimiters)
	const specialCharRatio =
		(content.match(/[<>\[\]{}|#*`~]/g) ?? []).length / content.length
	if (specialCharRatio > 0.15) {
		riskScore += 0.1
		flags.push("high_special_char_density")
	}

	// Trust modifier by content type — tool results get slightly elevated risk
	const trustModifier: Record<ContentType, number> = {
		text: 0.0, // user speech — baseline trust
		tool_call: 0.05,
		tool_result: 0.1, // external tool output — slightly elevated risk
		event: 0.0, // system events — baseline
	}
	riskScore += trustModifier[contentType] ?? 0.1

	// Cap at 1.0
	riskScore = Math.min(1.0, riskScore)

	const action = riskScore >= 0.5 ? "quarantine" : "allow"

	return { content, action, risk_score: riskScore, flags }
}

/**
 * Escape XML special characters in user-controlled memory content so that
 * stored content can never break out of the <memory> element or inject
 * additional XML elements into the agent context.
 */
function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")
}

/**
 * Format retrieved memories for agent injection.
 *
 * Wraps each memory in explicit XML-like delimiters so the agent's
 * system prompt can parse them without confusing them with instructions.
 * This prevents role-confusion / indirect injection via recalled content.
 * Memory content is XML-escaped to prevent stored content from breaking
 * out of the <memory> element.
 */
export function formatMemoriesForAgent(memories: RecalledMemory[]): string {
	if (memories.length === 0) return ""

	const formatted = memories.map((m) => {
		const confidence = m.confidence.toFixed(2)
		const created = m.created_at
		return (
			`<memory type="${m.memory_type}" confidence="${confidence}" created="${created}">\n` +
			`${escapeXml(m.content)}\n` +
			`</memory>`
		)
	})

	return (
		`<retrieved_memories count="${memories.length}">\n` +
		formatted.join("\n") +
		"\n</retrieved_memories>"
	)
}

/**
 * Strip secrets from content before storage.
 * Never stores passwords, API keys, SSNs, credit cards.
 */
export function redactSecrets(content: string): string {
	return (
		content
			// API keys (common formats)
			.replace(/\b(sk|pk|api|key|token)[-_][a-zA-Z0-9]{16,}/gi, "[REDACTED_KEY]")
			// JWT tokens
			.replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[REDACTED_JWT]")
			// Credit card numbers (basic pattern)
			.replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, "[REDACTED_CC]")
			// SSN
			.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED_SSN]")
			// Passwords in common patterns
			.replace(/password\s*[:=]\s*\S+/gi, "password: [REDACTED]")
			.replace(/passwd\s*[:=]\s*\S+/gi, "passwd: [REDACTED]")
	)
}
