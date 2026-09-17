#!/usr/bin/env node
import { main } from '../lib/main.js'

try {
  await main(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`fluvia: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
