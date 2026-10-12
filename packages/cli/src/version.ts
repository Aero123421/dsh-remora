declare const __REMORA_VERSION__: string | undefined
/** Replaced at bundle time by scripts/build.mjs; `0.0.0-dev` when run from source. */
export const CLI_VERSION: string = typeof __REMORA_VERSION__ === 'string' ? __REMORA_VERSION__ : '0.0.0-dev'
