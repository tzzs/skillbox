import {
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  select,
  text,
  type ConfirmOptions,
  type MultiSelectOptions,
  type SelectOptions,
  type TextOptions,
} from '@clack/prompts'

export interface PromptOption {
  value: string
  label: string
  hint?: string
}

export interface PromptSelectOptions {
  message: string
  options: readonly PromptOption[]
  initialValue?: string
}

export interface PromptMultiSelectOptions {
  message: string
  options: readonly PromptOption[]
  initialValues?: readonly string[]
}

export interface PromptConfirmOptions {
  message: string
  initialValue?: boolean
  active?: string
  inactive?: string
}

export interface PromptTextOptions {
  message: string
  placeholder?: string
  initialValue?: string
  validate?: (value: string) => string | undefined
}

/**
 * Narrow adapter over the interactive prompt primitives. The interactive layer
 * only talks through this interface, so business logic stays out and tests can
 * substitute a fake.
 */
export interface InteractivePrompt {
  intro(title?: string): void
  outro(message?: string): void
  note(message: string, title?: string): void
  info(message: string): void
  success(message: string): void
  warn(message: string): void
  error(message: string): void
  select(options: PromptSelectOptions): Promise<string | symbol>
  multiselect(options: PromptMultiSelectOptions): Promise<string[] | symbol>
  confirm(options: PromptConfirmOptions): Promise<boolean | symbol>
  text(options: PromptTextOptions): Promise<string | symbol>
}

/** True when a prompt was interrupted (cancel / Ctrl-C). */
export function isCancelResult(value: unknown): value is symbol {
  return isCancel(value)
}

function clackOptions(options: readonly PromptOption[]): PromptOption[] {
  return options.map((option) => ({ ...option }))
}

/** True when the process is attached to a real interactive terminal. */
export function isInteractiveTTY(): boolean {
  if (process.env.CI !== undefined && process.env.CI !== '') {
    return false
  }
  return Boolean(process.stdout.isTTY === true && process.stdin.isTTY === true)
}

/** Real `@clack/prompts` implementation of {@link InteractivePrompt}. */
export function createClackPrompts(): InteractivePrompt {
  return {
    intro: (title) => intro(title ?? ''),
    outro: (message) => outro(message),
    info: (message) => log.info(message),
    success: (message) => log.success(message),
    warn: (message) => log.warn(message),
    error: (message) => log.error(message),
    note: (message, title) => note(message, title),
    select: async (options: PromptSelectOptions): Promise<string | symbol> => {
      const args: SelectOptions<string> = {
        message: options.message,
        options: clackOptions(options.options),
      }
      if (options.initialValue !== undefined) {
        args.initialValue = options.initialValue
      }
      return select(args)
    },
    multiselect: async (options: PromptMultiSelectOptions): Promise<string[] | symbol> => {
      const args: MultiSelectOptions<string> = {
        message: options.message,
        options: clackOptions(options.options),
      }
      if (options.initialValues !== undefined) {
        args.initialValues = [...options.initialValues]
      }
      return multiselect(args)
    },
    confirm: async (options: PromptConfirmOptions): Promise<boolean | symbol> => {
      const args: ConfirmOptions = { message: options.message }
      if (options.initialValue !== undefined) {
        args.initialValue = options.initialValue
      }
      if (options.active !== undefined) {
        args.active = options.active
      }
      if (options.inactive !== undefined) {
        args.inactive = options.inactive
      }
      return confirm(args)
    },
    text: async (options: PromptTextOptions): Promise<string | symbol> => {
      const args: TextOptions = { message: options.message }
      if (options.placeholder !== undefined) {
        args.placeholder = options.placeholder
      }
      if (options.initialValue !== undefined) {
        args.initialValue = options.initialValue
      }
      if (options.validate !== undefined) {
        args.validate = options.validate as NonNullable<TextOptions['validate']>
      }
      return text(args)
    },
  }
}
