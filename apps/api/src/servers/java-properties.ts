/** A small implementation of the java.util.Properties text format used by server.properties. */
export class JavaPropertiesParseError extends Error {
  constructor(message: string) { super(message) }
}

const isPropertyWhitespace = (character: string | undefined) => character === ' ' || character === '\t' || character === '\f'

function decodeEscapes(value: string): string {
  let decoded = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    if (character !== '\\') { decoded += character; continue }
    const escaped = value[++index]
    if (escaped === undefined) throw new JavaPropertiesParseError('A property ends with an incomplete escape.')
    if (escaped === 't') decoded += '\t'
    else if (escaped === 'n') decoded += '\n'
    else if (escaped === 'r') decoded += '\r'
    else if (escaped === 'f') decoded += '\f'
    else if (escaped === 'u') {
      const digits = value.slice(index + 1, index + 5)
      if (!/^[\da-f]{4}$/i.test(digits)) throw new JavaPropertiesParseError('A property contains an invalid Unicode escape.')
      decoded += String.fromCharCode(Number.parseInt(digits, 16))
      index += 4
    } else decoded += escaped
  }
  return decoded
}

function logicalLines(text: string): string[] {
  const physical = text.split(/\r\n|\n|\r/)
  const logical: string[] = []
  for (let index = 0; index < physical.length; index += 1) {
    let line = physical[index]!
    while (true) {
      let backslashes = 0
      for (let cursor = line.length - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) backslashes += 1
      if (backslashes % 2 === 0 || index + 1 >= physical.length) break
      line = line.slice(0, -1)
      let continuation = physical[++index]!
      while (isPropertyWhitespace(continuation[0])) continuation = continuation.slice(1)
      line += continuation
    }
    logical.push(line)
  }
  return logical
}

function splitProperty(line: string): [string, string] | null {
  let keyStart = 0
  while (isPropertyWhitespace(line[keyStart])) keyStart += 1
  if (keyStart >= line.length || line[keyStart] === '#' || line[keyStart] === '!') return null

  let keyEnd = line.length
  let valueStart = line.length
  let escaped = false
  for (let index = keyStart; index < line.length; index += 1) {
    const character = line[index]!
    if (!escaped && (character === '=' || character === ':' || isPropertyWhitespace(character))) {
      keyEnd = index
      valueStart = index
      break
    }
    if (character === '\\') escaped = !escaped
    else escaped = false
  }

  while (valueStart < line.length && isPropertyWhitespace(line[valueStart])) valueStart += 1
  if (valueStart < line.length && (line[valueStart] === '=' || line[valueStart] === ':')) valueStart += 1
  while (valueStart < line.length && isPropertyWhitespace(line[valueStart])) valueStart += 1
  return [decodeEscapes(line.slice(keyStart, keyEnd)), decodeEscapes(line.slice(valueStart))]
}

/** Later duplicate keys replace earlier values, as in Properties.load. */
export function parseJavaProperties(text: string): Map<string, string> {
  const properties = new Map<string, string>()
  for (const line of logicalLines(text)) {
    const entry = splitProperty(line)
    if (entry) properties.set(entry[0], entry[1])
  }
  return properties
}

export type ServerPortConfiguration = {
  port: number | null
  status: 'valid' | 'missing' | 'invalid' | 'unreadable'
  errorCode: 'PORT_FILE_MISSING' | 'PORT_FILE_UNREADABLE' | 'PORT_PROPERTY_MISSING' | 'PORT_VALUE_INVALID' | null
}

export function parseServerPort(text: string): ServerPortConfiguration {
  let properties: Map<string, string>
  try { properties = parseJavaProperties(text) }
  catch { return { port: null, status: 'invalid', errorCode: 'PORT_VALUE_INVALID' } }
  if (!properties.has('server-port')) return { port: null, status: 'missing', errorCode: 'PORT_PROPERTY_MISSING' }
  const value = properties.get('server-port')!
  if (!/^\d{1,5}$/.test(value)) return { port: null, status: 'invalid', errorCode: 'PORT_VALUE_INVALID' }
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return { port: null, status: 'invalid', errorCode: 'PORT_VALUE_INVALID' }
  return { port, status: 'valid', errorCode: null }
}
