#!/usr/bin/env node
import { main } from '../dist/index.js'

main(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode
  },
  (error) => {
    console.error(error)
    process.exitCode = 1
  },
)
