import { Box, CircleHelp, Layers3 } from 'lucide-react'
import type { InstallSoftware, ServerSoftware } from '@mmsmanager/shared'

type SoftwareIdentityValue = InstallSoftware | ServerSoftware

const names: Record<SoftwareIdentityValue, string> = {
  vanilla: 'Vanilla', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', paper: 'Paper', unknown: 'Unknown',
}

export function SoftwareLogo({ software, className = '' }: { software: SoftwareIdentityValue; className?: string }) {
  const image = software === 'forge' || software === 'neoforge' || software === 'fabric' || software === 'paper'
    ? `/assets/loader-logos/${software === 'neoforge' ? 'neoforge' : software}.png`
    : null
  const Icon = software === 'vanilla' ? Box : software === 'unknown' ? CircleHelp : Layers3
  return <span className={`software-logo software-logo-${software} ${className}`} aria-hidden="true">
    {image ? <img src={image} alt="" /> : <Icon size={19} strokeWidth={1.7} />}
  </span>
}

export function SoftwareIdentity({
  software, version, className = '',
}: { software: SoftwareIdentityValue; version?: string | null; className?: string }) {
  return <span className={`software-identity ${className}`}>
    <SoftwareLogo software={software} />
    <span data-no-translate>{names[software]}{version ? ` ${version}` : ''}</span>
  </span>
}
