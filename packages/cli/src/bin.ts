import { main } from './main.ts'

const code = await main(process.argv.slice(2), {
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
  env: process.env,
  platform: process.platform,
  nodeVersion: process.version,
})
process.exitCode = code
