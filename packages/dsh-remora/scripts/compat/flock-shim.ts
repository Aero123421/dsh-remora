// Test-only stand-in for @deepseek-ai/node-addon-system/flock (a prebuilt
// native addon that is not installed here). The compat run is one process, so
// the JSONL backend's single-writer lease never contends.
export async function tryLockExclusive(_fd: number): Promise<void> {}
