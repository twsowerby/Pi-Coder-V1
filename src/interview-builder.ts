/**
 * Interview Builder — Pure functions that construct QuestionsFile objects from spec data.
 *
 * No side effects, no I/O, no server calls. Just data transformation.
 * Used by pi_coder_approve_spec and pi_coder_approve_final tools.
 */

import type { SpecFile, ImplementationUnit } from "./types.ts";

// ---------------------------------------------------------------------------
// Inline types matching pi-interview/schema.ts (avoids runtime import risk)
// ---------------------------------------------------------------------------

interface ContentBlock {
	source: string;
	lang?: string;
	file?: string;
	title?: string;
}

interface TableMediaBlock {
	type: "table";
	table: { headers: string[]; rows: string[][]; highlights?: number[] };
	caption?: string;
}

interface Question {
	id: string;
	type: "single" | "multi" | "text" | "image" | "info";
	question: string;
	options?: string[];
	recommended?: string;
	conviction?: "strong" | "slight";
	weight?: "critical" | "minor";
	context?: string;
	content?: ContentBlock;
	media?: TableMediaBlock;
}

interface QuestionsFile {
	title?: string;
	description?: string;
	questions: Question[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a markdown bulleted list from an array of strings. */
function bulletList(items: string[]): string {
	return items.map((item) => `- ${item}`).join("\n");
}

/** Format a markdown numbered list from an array of strings. */
function numberedList(items: string[]): string {
	return items.map((item, i) => `${i + 1}. ${item}`).join("\n");
}

/** Format a single implementation unit as a detail block. */
export function formatUnitDetail(unit: ImplementationUnit, spec: SpecFile): string {
	const lines: string[] = [];

	if (unit.acceptanceCriteriaIndices.length > 0) {
		lines.push("**Acceptance Criteria:**");
		for (const idx of unit.acceptanceCriteriaIndices) {
			const ac = spec.acceptanceCriteria[idx];
			if (ac) lines.push(`- AC${idx + 1}: ${ac}`);
		}
	}

	lines.push(`**Test Strategy:** ${unit.testStrategy}`);
	if (unit.testStrategyRationale) {
		lines.push(`> ${unit.testStrategyRationale}`);
	}

	if (unit.keyFiles.length > 0) {
		lines.push(`**Key Files:** ${unit.keyFiles.join(", ")}`);
	}

	if (unit.dependsOn.length > 0) {
		lines.push(`**Depends On:** ${unit.dependsOn.join(", ")}`);
	}

	if (unit.testSuite) {
		lines.push(`**Test Suite:** ${unit.testSuite}`);
	}

	return lines.join("\n\n");
}

/** Build the implementation plan table rows. */
function buildImplPlanRows(plan: ImplementationUnit[]): string[][] {
	return plan.map((unit) => [
		unit.name,
		unit.acceptanceCriteriaIndices.map((i) => `AC${i + 1}`).join(", "),
		unit.testStrategy,
		unit.keyFiles.join(", ") || "—",
	]);
}

// ---------------------------------------------------------------------------
// Spec Approval Questions
// ---------------------------------------------------------------------------

/**
 * Build the spec approval interview questions from a saved spec.
 *
 * Structure: spec overview → scope approval → AC info → AC approval →
 * constraints info → constraints approval → impl plan table → plan approval →
 * conditional non-TDD strategy → conditional test-suite mapping.
 *
 * Grouped (not per-unit): the implementation plan table shows all units in one
 * view. The spec file is the source of truth for detail, and the interview's
 * purpose is overview + go/no-go.
 */
export function buildSpecApprovalQuestions(spec: SpecFile): QuestionsFile {
	const questions: Question[] = [];

	// 1. Spec overview (info)
	questions.push({
		id: "spec-overview",
		type: "info",
		question: spec.title,
		content: {
			source: [
				`# ${spec.title}`,
				"",
				spec.prunedContext
					? `## Context\n${spec.prunedContext}`
					: null,
				spec.keyFiles.length > 0
					? `## Key Files\n${bulletList(spec.keyFiles)}`
					: null,
			]
				.filter(Boolean)
				.join("\n"),
			lang: "md",
		},
	});

	// 2. Scope approval
	questions.push({
		id: "scope",
		type: "single",
		question: `Does this scope match your intent? We're building: ${spec.title}.`,
		options: ["Approve", "Needs changes"],
		recommended: "Approve",
		weight: "critical",
	});

	// 3. Acceptance criteria (info)
	questions.push({
		id: "acceptance-criteria",
		type: "info",
		question: "Acceptance Criteria",
		content: {
			source: `## Acceptance Criteria\n\n${numberedList(spec.acceptanceCriteria)}`,
			lang: "md",
		},
	});

	// 4. AC approval
	questions.push({
		id: "ac-approval",
		type: "single",
		question: "Are these the right tests of 'done'?",
		options: ["Approve", "Needs changes"],
		recommended: "Approve",
		weight: "critical",
	});

	// 5. Constraints (info)
	questions.push({
		id: "constraints",
		type: "info",
		question: "Constraints",
		content: {
			source: spec.constraints.length > 0
				? `## Constraints\n\n${bulletList(spec.constraints)}`
				: "No constraints defined for this spec.",
			lang: "md",
		},
	});

	// 6. Constraints approval
	questions.push({
		id: "constraints-approval",
		type: "single",
		question: "Anything missing or wrong with the constraints?",
		options: ["Approve", "Needs changes"],
		recommended: "Approve",
	});

	// 7. Implementation plan overview (info with table)
	questions.push({
		id: "impl-plan",
		type: "info",
		question: "Implementation Plan",
		media: {
			type: "table",
			table: {
				headers: ["Unit", "ACs", "Strategy", "Key Files"],
				rows: buildImplPlanRows(spec.implementationPlan),
			},
		},
	});

	// 8. Plan approval
	questions.push({
		id: "plan-approval",
		type: "single",
		question: "Does this decomposition look right?",
		options: ["Approve", "Needs changes"],
		recommended: "Approve",
		weight: "critical",
	});

	// 9. Non-TDD strategy (conditional — only if verify/skip units exist)
	const nonTddUnits = spec.implementationPlan.filter(
		(u) => u.testStrategy !== "tdd",
	);
	if (nonTddUnits.length > 0) {
		const unitList = nonTddUnits
			.map(
				(u) =>
					`• **${u.name}**: ${u.testStrategy}${u.testStrategyRationale ? ` — ${u.testStrategyRationale}` : ""}`,
			)
			.join("\n");

		questions.push({
			id: "non-tdd-strategy",
			type: "single",
			question: `${nonTddUnits.length} of ${spec.implementationPlan.length} units use verify or skip strategy:\n\n${unitList}\n\nIf any could have a test-first contract, consider reclassifying as tdd.`,
			options: ["Approve", "Change to TDD"],
			recommended: "Approve",
			weight: "critical",
		});
	}

	// 10. Test suite mapping (conditional — only if units have custom testSuite)
	const customSuiteUnits = spec.implementationPlan.filter(
		(u) => u.testSuite,
	);
	if (customSuiteUnits.length > 0) {
		const suiteList = customSuiteUnits
			.map((u) => `• **${u.name}** → \`${u.testSuite}\``)
			.join("\n");

		questions.push({
			id: "test-suite-mapping",
			type: "single",
			question: `The following units map to specific test suites:\n\n${suiteList}\n\nApprove these assignments?`,
			options: ["Approve", "Change"],
			recommended: "Approve",
		});
	}

	return {
		title: `Spec Approval: ${spec.title}`,
		description:
			"Review the spec and approve or request changes for each section.",
		questions,
	};
}

// ---------------------------------------------------------------------------
// Final Report Questions
// ---------------------------------------------------------------------------

/**
 * Build the final report interview questions from a saved spec.
 *
 * Structure: changes summary → test results → review verdict →
 * knowledge learnings → final approval.
 *
 * Info panels use placeholder text because the tool doesn't have access to
 * live test/review/knowledge data — those context panels show the spec's
 * structure, and the real data is in the LLM's conversation context.
 */
export function buildFinalReportQuestions(spec: SpecFile): QuestionsFile {
	const questions: Question[] = [];

	// 1. Changes summary (info)
	questions.push({
		id: "changes-summary",
		type: "info",
		question: "Summary of Changes",
		content: {
			source: [
				`# ${spec.title} — Implementation Summary`,
				"",
				`All ${spec.implementationPlan.length} implementation unit(s) have been processed.`,
				"Review the detailed changes in the conversation above.",
			].join("\n"),
			lang: "md",
		},
	});

	// 2. Test results (info with table)
	questions.push({
		id: "test-results",
		type: "info",
		question: "Test Results",
		media: {
			type: "table",
			table: {
				headers: ["Unit", "Strategy", "Result"],
				rows: spec.implementationPlan.map((u) => [
					u.name,
					u.testStrategy,
					"See conversation",
				]),
			},
		},
	});

	// 3. Review verdict (info)
	questions.push({
		id: "review-verdict",
		type: "info",
		question: "Review Verdict",
		content: {
			source: "Review the verdict details in the conversation above.",
			lang: "md",
		},
	});

	// 4. Knowledge learnings (info)
	questions.push({
		id: "knowledge-learnings",
		type: "info",
		question: "Knowledge Learnings",
		content: {
			source:
				"Any learnings discovered during this cycle have been persisted via upsert_knowledge. Review them in the conversation above.",
			lang: "md",
		},
	});

	// 5. Final approval
	questions.push({
		id: "final-approval",
		type: "single",
		question: "Do you approve merging these changes?",
		options: ["Approve", "Rollback"],
		recommended: "Approve",
		weight: "critical",
	});

	return {
		title: `Final Report: ${spec.title}`,
		description:
			"Review the implementation results and approve merge or rollback.",
		questions,
	};
}
