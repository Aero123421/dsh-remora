/** CSS of the official primitives, registered by their compiled CSS modules (scripts/build.mjs). */
export const officialCss: string[] = []

export function addOfficialCss(css: string): void {
  officialCss.push(css)
}
