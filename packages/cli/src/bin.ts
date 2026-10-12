import { defaultCtx } from './ctx.ts'
import { main } from './main.ts'

// No top-level await: the standalone binary runs this bundle as CommonJS.
main(process.argv.slice(2), defaultCtx()).then(
  code => { process.exitCode = code },
  error => { process.stderr.write(`remora: ${String(error)}\n`); process.exitCode = 1 },
)
