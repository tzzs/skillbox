#!/usr/bin/env node
import { main } from '@skillbox/cli'

process.exitCode = main(process.argv.slice(2))
