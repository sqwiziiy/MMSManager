import { describe, expect, it } from 'vitest'
import { JavaPropertiesParseError, parseJavaProperties, parseServerPort } from './java-properties.js'

describe('Java Properties parsing for server configuration', () => {
  it('ignores comments, parses whitespace and separators, and applies the last duplicate', () => {
    const properties = parseJavaProperties([
      '  # server-port=25560',
      '! server-port:25561',
      'server-port : 25562',
      'server-port=25563',
      'motd:  hello world',
    ].join('\n'))
    expect(properties.get('server-port')).toBe('25563')
    expect(properties.get('motd')).toBe('hello world')
    expect(parseServerPort('server-port=25563\n')).toMatchObject({ port: 25563, status: 'valid', errorCode: null })
  })

  it('handles escaped key characters, Unicode escapes, and continued lines', () => {
    const properties = parseJavaProperties('server\\-port=25570\nserver-\\\n port=25571\nmessage=hello\\u0020world\n')
    expect(properties.get('server-port')).toBe('25571')
    expect(parseServerPort('server\\-port=25570\nserver-\\\n port=25571\n').port).toBe(25571)
    expect(properties.get('message')).toBe('hello world')
  })

  it('reports absent, malformed, and out-of-range ports without a fallback', () => {
    expect(parseServerPort('# server-port=25565\n')).toMatchObject({ port: null, status: 'missing', errorCode: 'PORT_PROPERTY_MISSING' })
    expect(parseServerPort('server-port=not-a-number\n')).toMatchObject({ port: null, status: 'invalid', errorCode: 'PORT_VALUE_INVALID' })
    expect(parseServerPort('server-port=65536\n')).toMatchObject({ port: null, status: 'invalid', errorCode: 'PORT_VALUE_INVALID' })
    expect(parseServerPort('server-port=25565\\u12xz\n')).toMatchObject({ port: null, status: 'invalid', errorCode: 'PORT_VALUE_INVALID' })
  })

  it('rejects malformed Unicode escapes as Java Properties does', () => {
    expect(() => parseJavaProperties('motd=broken\\u12xz')).toThrow(JavaPropertiesParseError)
  })
})
