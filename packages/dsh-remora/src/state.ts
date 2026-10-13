/**
 * Types shared by the host side and the settings tab. The browser bundle
 * imports these as types only; the runtime lives in `core/`.
 */
export type { RemoraSnapshot, OperationRow, ClientSummary } from './core/remora.ts'
export type { AuditEntry } from './core/audit.ts'
export type { Catalog, CatalogItem } from './core/catalog.ts'
export type { UpdateCheck, ReleaseInfo, UpdateInstallation } from './core/updates.ts'
export type { RemoraSettings, ScopeSettings, Placement, SessionException } from './core/settings.ts'
export type { LinkStatus, LinkState } from './core/connection.ts'
export type { PairingView, PairingPhase } from './core/pairing.ts'
export type { QuestionModeReport, PresetQuestionMode, QuestionMode } from './core/question-mode.ts'
