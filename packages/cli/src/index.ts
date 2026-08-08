import { version } from '@skillbox/core'
import { assertNever } from '@skillbox/shared'

export type CliCommand = 'help' | 'version' | 'unknown'

export function helpText(): string {
  return [
    'skillbox - manage your agent skills',
    '',
    'Usage:',
    '  skillbox --help      Show this help',
    '  skillbox --version   Print the current version',
    '',
    'Run `skillbox <command> --help` for command-specific help.',
  ].join('\n')
}

export function parseCommand(args: string[]): CliCommand {
  const [arg] = args
  if (arg === '--help' || arg === '-h' || arg === 'help') return 'help'
  if (arg === '--version' || arg === '-v' || arg === 'version') return 'version'
  return 'unknown'
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const command = parseCommand(argv)
  switch (command) {
    case 'help':
      console.log(helpText())
      return 0
    case 'version':
      console.log(version)
      return 0
    case 'unknown':
      console.error(`Unknown argument: ${argv[0] ?? ''}`)
      console.error('Run "skillbox --help" for usage.')
      return 1
    default:
      return assertNever(command)
  }
}
