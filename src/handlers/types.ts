/**
 * Pi Coder V1 — Handler Context
 *
 * Shared context object passed to all extracted handler and command functions.
 * Provides access to module-level state via getter/setter closures, allowing
 * extracted modules to read/write shared state without circular imports.
 *
 * Created once inside `piCoderExtension()` and passed to all handlers.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiCoderConfig, PiCoderMode, IStateMachine } from "../types.ts";
import type { LogEventType } from "../logger.ts";
import type { TokenTracker } from "../token-tracker.ts";
import type { NudgeEngine } from "../nudge-engine.ts";
import type { SubagentMonitor } from "../subagent-monitor.ts";
import type { SpecManager } from "../spec.ts";
import type { GitOperations } from "../git.ts";
import type { TddRunner } from "../tdd-runner.ts";
import type { KnowledgeStore } from "../knowledge.ts";
import type { Logger } from "../logger.ts";
import type { GlobalStatePersistence } from "../state-persistence.ts";

/** Structured logging function — logs events with session metadata. */
export type LogEventFn = (type: LogEventType, payload: Record<string, unknown>) => void;

/** Persist current FSM state to disk. */
export type PersistStateFn = () => Promise<void>;

/** Refresh all pi-coder UI surfaces based on current state. */
export type RefreshUIFn = () => void;

/** Refresh the subagent activity widget. */
export type RefreshSubagentWidgetFn = () => void;

/**
 * Shared context passed to all extracted handlers and commands.
 *
 * Getters/setters for mutable module-level state always return the current
 * value because they close over `let` bindings in `index.ts`.
 */
export interface HandlerContext {
  // --- Extension API ---
  pi: ExtensionAPI;

  // --- Mutable module state (getters + setters) ---
  get piCoderMode(): PiCoderMode;
  set piCoderMode(m: PiCoderMode);
  get stateMachine(): IStateMachine | null;
  set stateMachine(sm: IStateMachine | null);
  get config(): PiCoderConfig;
  set config(c: PiCoderConfig);
  get subagentsAvailable(): boolean;
  set subagentsAvailable(v: boolean);
  get activeSpecId(): string | null;
  set activeSpecId(id: string | null);

  // --- Service instances ---
  tokenTracker: TokenTracker;
  nudgeEngine: NudgeEngine;
  subagentMonitor: SubagentMonitor;
  get specManager(): SpecManager;
  set specManager(sm: SpecManager);
  get sessionCtx(): ExtensionContext | null;
  set sessionCtx(ctx: ExtensionContext | null);
  get logger(): Logger;
  set logger(l: Logger);
  get sessionId(): string;
  set sessionId(id: string);
  get gitOps(): GitOperations;
  set gitOps(go: GitOperations);
  get tddRunner(): TddRunner;
  set tddRunner(tr: TddRunner);
  get knowledgeStore(): KnowledgeStore;
  set knowledgeStore(ks: KnowledgeStore);
  get globalStatePersistence(): GlobalStatePersistence;
  set globalStatePersistence(gsp: GlobalStatePersistence);
  get specStateCreatedAt(): string | null;
  set specStateCreatedAt(v: string | null);
  get projectCwd(): string;
  set projectCwd(cwd: string);

  // --- Infrastructure functions (module-level in index.ts) ---
  logEvent: LogEventFn;
  persistState: PersistStateFn;
  refreshUI: RefreshUIFn;
  refreshSubagentWidget: RefreshSubagentWidgetFn;
}
