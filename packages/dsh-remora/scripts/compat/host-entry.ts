// Compiled by scripts/compat/run.mjs against the pinned official DSH source.
// Re-exports the real services the compat run composes, plus small test-only
// pieces taken from DSH's own test harness.
export { Context } from '@deepseek-ai/cordis'
export { default as LlmRuntime } from '@deepseek-ai/dsh-llm'
export { default as SessionStore, SessionId } from '@deepseek-ai/dsh-session'
export { default as SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
export { default as SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
export { default as ToolRuntime } from '@deepseek-ai/dsh-tools'
export { default as AgentRegistry } from '@deepseek-ai/dsh-agent'
export { default as AgentLoop } from '@deepseek-ai/dsh-agent-loop'
export { default as JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
export * as SessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
export { default as SessionProjectionCache } from '@deepseek-ai/dsh-session-projection-cache'
export { default as SessionController } from '@deepseek-ai/dsh-api-session-controller'
export { default as Storage } from '@deepseek-ai/dsh-storage'
export * as StorageJson from '@deepseek-ai/dsh-storage-json'
export * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
export { default as WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
export * as TurnOutline from '@deepseek-ai/dsh-session-turn-outline'
export { default as TokenMeter } from '@deepseek-ai/dsh-token-meter'
export { default as SessionTitleService } from '@deepseek-ai/dsh-session-title'
export { default as UserQuestionService } from '@deepseek-ai/dsh-user-questions'
export * as ToolAskUser from '@deepseek-ai/dsh-tool-ask-user'
// DSH's own scripted model adapter (packages/core/agent-loop/tests/mock-adapter.ts).
export { MockAdapter, textResponse, toolCallResponse } from '@dsh-compat/mock-adapter'

import SessionQueryEngine from '@deepseek-ai/dsh-session-query'

/** Point reads and listings only, like DSH's own controller tests (no full-text search engine). */
export class CompatSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('search is not composed in the compat run'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('search is not composed in the compat run'))
  }
}
