/** A listener receives a published event without taking ownership of it. */
export type EventListener<TEvent> = (event: TEvent) => void

/** Result of a best-effort event delivery. Producer execution never depends on observers. */
export interface EventDeliveryResult {
  delivered: number
  failures: readonly unknown[]
}

/** Minimal publish/subscribe contract shared by Core progress producers and UIs. */
export interface EventPublisher<TEvent> {
  emit(event: TEvent): EventDeliveryResult
}

export interface EventSubscriber<TEvent> {
  subscribe(listener: EventListener<TEvent>): () => void
}
