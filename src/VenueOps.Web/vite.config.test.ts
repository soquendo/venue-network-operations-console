import { describe, expect, it } from 'vitest'
import { resolveConfig } from 'vite'

describe('local simulator proxy availability', () => {
  it.each([
    { name: 'development', command: 'serve' as const, preview: false, available: true },
    { name: 'preview', command: 'serve' as const, preview: true, available: false },
    { name: 'build', command: 'build' as const, preview: false, available: false },
  ])('$name preserves the API route and scopes simulator access', async ({ command, preview, available }) => {
    const config = await resolveConfig({}, command, 'development', 'development', preview)
    expect(config.server.proxy?.['/api']).toBe('http://localhost:8080')
    expect(config.preview.proxy?.['/api']).toBe('http://localhost:8080')
    const routes = Object.entries(config.server.proxy ?? {}).filter(([key]) => key.includes('simulation'))
    expect(routes).toEqual(available ? [['^/simulation(?:/|$)', 'http://127.0.0.1:8081']] : [])
    if (preview) expect(Object.keys(config.preview.proxy ?? {}).some(key => key.includes('simulation'))).toBe(false)
  })
})
