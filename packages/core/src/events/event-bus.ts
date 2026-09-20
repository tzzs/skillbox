import type {
  EventDeliveryResult,
  EventListener,
  EventPublisher,
  EventSubscriber,
} from './types.js'

/**
 * In-process event boundary for progress and business activity. Observer
 * failures are isolated so telemetry or UI listeners cannot break mutations.
 */
export class EventBus<TEvent> implements EventPublisher<TEvent>, EventSubscriber<TEvent> {
  private readonly listeners = new Set<EventListener<TEvent>>()

  subscribe(listener: EventListener<TEvent>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: TEvent): EventDeliveryResult {
    let delivered = 0
    const failures: unknown[] = []
    for (const listener of this.listeners) {
      try {
        listener(event)
        delivered += 1
      } catch (error) {
        failures.push(error)
      }
    }
    return { delivered, failures }
  }
}
