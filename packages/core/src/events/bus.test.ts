import { describe, expect, it } from 'vitest'
import { EventBus } from './bus.js'
import type { SkillboxEvent } from './bus.js'

describe('EventBus', () => {
  it('delivers events to subscribers and supports unsubscribe', () => {
    const bus = new EventBus()
    const received: SkillboxEvent[] = []
    const subscription = bus.on((event) => received.push(event))
    const second: SkillboxEvent[] = []
    const secondSubscription = bus.on((event) => second.push(event))

    bus.emit({ type: 'install:phase', phase: 'resolve', alias: 'hello' })
    subscription.unsubscribe()
    bus.emit({ type: 'install:completed', alias: 'hello' })

    expect(received.map((event) => event.type)).toEqual(['install:phase'])
    expect(second.map((event) => event.type)).toEqual(['install:phase', 'install:completed'])
    expect(bus.listenerCount()).toBe(1)
    secondSubscription.unsubscribe()
    expect(bus.listenerCount()).toBe(0)
  })

  it('isolates a throwing subscriber so emit never breaks', () => {
    const bus = new EventBus()
    const ok: SkillboxEvent[] = []
    bus.on(() => {
      throw new Error('bad listener')
    })
    bus.on((event) => ok.push(event))

    expect(() => bus.emit({ type: 'install:phase', phase: 'scan', alias: 'x' })).not.toThrow()
    expect(ok).toHaveLength(1)
  })
})
