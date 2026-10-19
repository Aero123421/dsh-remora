/**
 * Japanese copy is registered with the Remora namespace. The selectable `ja`
 * language is shared with other plugins (dsh-japanese registers the same id).
 * Add it only when the catalog does not already contain it, and dispose only
 * the definition this call created.
 */
import { en, ja, NS } from './locales.ts'

export const JAPANESE_LANGUAGE = { id: 'ja', label: '日本語', fallback: 'en' } as const

export interface JapaneseLocale {
  register(ns: string, copy: Record<string, Record<string, string>>): () => void
  getSnapshot(): { locales?: ReadonlyArray<{ id: string }> }
  addLanguage?(input: { id: string; label: string; fallback: string }): () => void
}

export function hasJapanese(locales: ReadonlyArray<{ id: string }> | undefined): boolean {
  return locales?.some(locale => locale.id.toLowerCase() === JAPANESE_LANGUAGE.id) ?? false
}

function alreadyRegistered(error: unknown): boolean {
  return error instanceof Error && error.message.includes('already registered')
}

/** Register Remora's dictionaries and, when needed, the shared Japanese language. */
export function attachJapanese(locale: JapaneseLocale): () => void {
  const disposeCopy = locale.register(NS, { en, ja })
  if (typeof locale.addLanguage !== 'function' || hasJapanese(locale.getSnapshot().locales)) return disposeCopy
  try {
    const disposeLanguage = locale.addLanguage(JAPANESE_LANGUAGE)
    return () => {
      disposeCopy()
      disposeLanguage()
    }
  } catch (error) {
    if (alreadyRegistered(error)) return disposeCopy
    disposeCopy()
    throw error
  }
}
