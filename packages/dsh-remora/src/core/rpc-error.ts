/** A settings-RPC failure with a stable code the client maps to localized text. */
export class RpcError extends Error {
  readonly code: string
  readonly detail: string | undefined
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.code = code
    this.detail = detail
  }
}
