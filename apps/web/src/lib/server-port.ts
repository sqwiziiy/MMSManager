export function serverPortIssueText(errorCode: string | null | undefined): string | null {
  switch (errorCode) {
    case 'PORT_FILE_MISSING': return 'server.properties is missing'
    case 'PORT_FILE_UNREADABLE': return 'server.properties could not be read'
    case 'PORT_PROPERTY_MISSING': return 'server.properties has no server-port value'
    case 'PORT_VALUE_INVALID': return 'server.properties contains an invalid server-port value'
    default: return null
  }
}
