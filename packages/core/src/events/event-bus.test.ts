import { describe, expect, it } from 'vitest'
import { EventBus } from './event-bus.js'

describe('EventBus', () => {
  it('delivers events to subscribers in subscription order', () => {
    const bus = new EventBus<{ readonly name: string }>()
    const received: string[] = []
    bus.subscribe((event) => received.push(`first:${event.name}`))
    bus.subscribe((event) => received.push(`second:${event.name}`))

    bus.emit({ name: 'migrate' })

    expect(received).toEqual(['first:migrate', 'second:migrate'])
  })

  it('keeps delivering when one subscriber fails and reports the failure', () => {
    const bus = new EventBus<{ readonly name: string }>()
    const received: string[] = []
    bus.subscribe(() => {
      throw new Error('observer failure')
    })
    bus.subscribe((event) => received.push(event.name))

    const result = bus.emit({ name: 'migrate' })

    expect(received).toEqual(['migrate'])
    expect(result.failures).toHaveLength(1)
    expect(result.delivered).toBe(1)
  })

  it('stops a removed subscriber from receiving later events', () => {
    const bus = new EventBus<string>()
    const received: string[] = []
    const unsubscribe = bus.subscribe((event) => received.push(event))

    unsubscribe()
    bus.emit('later')

    expect(received).toEqual([])
  })
})
