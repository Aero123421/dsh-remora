import { defaultCtx } from './ctx.ts'
import { main } from './main.ts'

// `remora ... | head` closes stdout early: stop quietly instead of crashing on EPIPE.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => { if (error.code === 'EPIPE') process.exit(process.exitCode ?? 0); throw error })
}

// No top-level await: the standalone binary runs this bundle as CommonJS.
main(process.argv.slice(2), defaultCtx()).then(
  code => { process.exitCode = code },
  error => { process.stderr.write(`remora: ${String(error)}\n`); process.exitCode = 1 },
)
