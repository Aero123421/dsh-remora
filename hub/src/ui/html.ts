/**
 * Escaping and the `h` template. Every value from outside (DSH titles,
 * client names, codes) goes through `escapeHtml` unless wrapped in `raw()`.
 */
const ENTITIES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ENTITIES[char] ?? char)
}

/** Markup that is already safe. */
export class Raw {
  readonly value: string
  constructor(value: string) {
    this.value = value
  }
  toString(): string {
    return this.value
  }
}

export const raw = (value: string) => new Raw(value)

export type Value = string | number | boolean | null | undefined | Raw | readonly Value[]

function render(value: Value): string {
  if (value === null || value === undefined || value === false) return ''
  if (value instanceof Raw) return value.value
  if (Array.isArray(value)) return value.map(item => render(item)).join('')
  return escapeHtml(String(value))
}

/** Tagged template that escapes every interpolated value unless it is `raw(...)`. */
export function h(strings: TemplateStringsArray, ...values: Value[]): Raw {
  let out = strings[0] ?? ''
  for (let i = 0; i < values.length; i++) out += render(values[i]) + (strings[i + 1] ?? '')
  return new Raw(out)
}
