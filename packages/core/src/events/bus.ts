/**
 * In-process event bus (roadmap 5.1 OperationRuntime / GAP §4.4). Long-running
 * core flows (install, reconcile, sync, ...) emit typed events; CLI / Web /
 * TUI consumers subscribe for progress, audit logging and real-time UI.
 */

export type SkillboxEvent =
  | {
      type: 'install:phase'
      phase: string
      alias: string
      revision?: string
      detail?: string
    }
  | { type: 'install:completed'; alias: string; revision?: string; integrity?: string }
  | { type: 'install:failed'; alias: string; error: string }
  | { type: 'reconcile:started' }
  | { type: 'reconcile:completed'; changed: boolean; skills: number; problems: number }

/** Synchronous subscriber; `emit` never awaits subscribers. */
export type SkillboxEventListener = (event: SkillboxEvent) => void

export interface EventSubscription {
  /** Detaches this subscriber; safe to call multiple times. */
  unsubscribe(): void
}

/**
 * Minimal typed event bus. Emitting is fire-and-forget: a throwing listener
 * is isolated so one bad consumer cannot break a core transaction.
 */
export class EventBus {
  private readonly listeners = new Set<SkillboxEventListener>()

  /** Registers a subscriber; returns a handle to detach it. */
  on(listener: SkillboxEventListener): EventSubscription {
    this.listeners.add(listener)
    let active = true
    return {
      unsubscribe: () => {
        if (active) {
          active = false
          this.listeners.delete(listener)
        }
      },
    }
  }

  /** Number of active subscribers (diagnostics). */
  listenerCount(): number {
    return this.listeners.size
  }

  /** Delivers `event` to every subscriber; listener errors never propagate. */
  emit(event: SkillboxEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // A misbehaving subscriber must not break the emitting flow.
      }
    }
  }
}

/** Process-wide default bus shared by Core flows and the CLI/Web layers. */
export const defaultEventBus = new EventBus()

/** Convenience: emit on the default bus. */
export function emitSkillboxEvent(event: SkillboxEvent): void {
  defaultEventBus.emit(event)
}
