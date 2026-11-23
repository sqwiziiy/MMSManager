import { useEffect, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Cpu, HardDrive, MemoryStick, Monitor, Server, X } from 'lucide-react'
import { Button, IconButton, PreviewFlag } from './ui'

type WizardStep = 'details' | 'software' | 'resources' | 'review'
const steps: { id: WizardStep; label: string }[] = [
  { id: 'details', label: 'Details' },
  { id: 'software', label: 'Software' },
  { id: 'resources', label: 'Resources' },
  { id: 'review', label: 'Review' },
]
const softwareOptions = [
  { name: 'Fabric', version: '1.21.4', description: 'A lightweight modding platform', mark: 'F' },
  { name: 'Paper', version: '1.21.4', description: 'A plugin-ready server fork', mark: 'P' },
  { name: 'Vanilla', version: '1.21.4', description: 'The original server experience', mark: 'V' },
  { name: 'NeoForge', version: '1.20.1', description: 'A community modding platform', mark: 'N' },
]

export function CreateServerWizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<WizardStep>('details')
  const [name, setName] = useState('New community server')
  const [software, setSoftware] = useState('Fabric')
  const [memory, setMemory] = useState(6)
  const [reviewed, setReviewed] = useState(false)
  const currentIndex = steps.findIndex((item) => item.id === step)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const next = () => {
    if (step === 'review') setReviewed(true)
    else setStep(steps[currentIndex + 1]!.id)
  }

  return <div className="overlay-scrim wizard-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="wizard-dialog" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
      <div className="wizard-header"><div><div className="wizard-kicker"><span className="wizard-kicker-icon"><Server size={14} /></span> Workspace preview <PreviewFlag /></div><h2 id="wizard-title">Create server</h2><p>Explore a setup flow without installing or changing files.</p></div><IconButton icon={X} label="Close create server preview" onClick={onClose} /></div>
      {!reviewed && <div className="wizard-steps" aria-label="Creation steps">{steps.map((item, index) => <div className={`wizard-step ${step === item.id ? 'active' : ''} ${index < currentIndex ? 'complete' : ''}`} key={item.id}><span>{index < currentIndex ? <Check size={13} /> : `0${index + 1}`}</span><small>{item.label}</small>{index < steps.length - 1 && <i />}</div>)}</div>}

      {reviewed ? <div className="wizard-complete"><span className="wizard-complete-icon"><Check size={22} /></span><p className="eyebrow">Preview prepared</p><h3>Setup summary is ready</h3><p>The example configuration is shown below. No server was created, and nothing was installed or written.</p><div className="wizard-summary-list"><div><span>Server name</span><strong>{name || 'Untitled server'}</strong></div><div><span>Software</span><strong>{software} · {softwareOptions.find((item) => item.name === software)?.version}</strong></div><div><span>Memory profile</span><strong>{memory} GB sample allocation</strong></div></div><Button kind="primary" onClick={onClose}>Done</Button></div> : <>
        <div className="wizard-body">
          {step === 'details' && <div className="wizard-step-content"><div className="wizard-step-intro"><span className="wizard-content-icon"><Server size={18} /></span><div><h3>Name this preview</h3><p>Choose a label for the sample configuration.</p></div></div><FieldWizard label="Server name"><input autoFocus value={name} maxLength={40} onChange={(event) => setName(event.target.value)} placeholder="e.g. Alder community" /></FieldWizard><div className="wizard-info-row"><Monitor size={15} /><span>This screen only stores the name in temporary browser state.</span></div></div>}
          {step === 'software' && <div className="wizard-step-content"><div className="wizard-step-intro"><span className="wizard-content-icon"><Server size={18} /></span><div><h3>Choose server software</h3><p>These are sample options for the setup review.</p></div></div><div className="software-options">{softwareOptions.map((option) => <button className={`software-option ${software === option.name ? 'selected' : ''}`} key={option.name} onClick={() => setSoftware(option.name)}><span className={`software-mark software-${option.name.toLowerCase()}`}>{option.mark}</span><span><strong>{option.name}</strong><small>{option.description}</small></span><span className="software-version">{option.version}</span><span className="software-radio" /></button>)}</div><div className="wizard-info-row"><HardDrive size={15} /><span>Version selection is illustrative. No download is available.</span></div></div>}
          {step === 'resources' && <div className="wizard-step-content"><div className="wizard-step-intro"><span className="wizard-content-icon"><MemoryStick size={18} /></span><div><h3>Set a resource profile</h3><p>Adjust the example memory allocation for the review.</p></div></div><div className="memory-select"><div><span>Allocated memory</span><strong>{memory} <small>GB</small></strong></div><input type="range" min="2" max="12" step="1" value={memory} onChange={(event) => setMemory(Number(event.target.value))} aria-label="Example memory allocation" /><div className="range-labels"><span>2 GB</span><span>12 GB</span></div></div><div className="wizard-resource-grid"><div><Cpu size={16} /><span>Java runtime</span><strong>Java 21</strong><small>sample profile</small></div><div><HardDrive size={16} /><span>Storage</span><strong>Automatic</strong><small>not reserved</small></div></div><div className="wizard-info-row"><Cpu size={15} /><span>Resource values do not reserve or inspect host capacity.</span></div></div>}
          {step === 'review' && <div className="wizard-step-content"><div className="wizard-step-intro"><span className="wizard-content-icon"><Check size={18} /></span><div><h3>Review setup</h3><p>Confirm the values for this non-operational preview.</p></div></div><div className="wizard-review-card"><div className="wizard-review-banner"><span className="wizard-review-mark"><Server size={18} /></span><div><strong>{name || 'Untitled server'}</strong><small>Local node preview · not created</small></div><PreviewFlag /></div><div className="wizard-review-grid"><div><span>Software</span><strong>{software} {softwareOptions.find((item) => item.name === software)?.version}</strong></div><div><span>Memory</span><strong>{memory} GB example allocation</strong></div><div><span>Java</span><strong>Java 21 preview</strong></div><div><span>Install location</span><strong>Not selected</strong></div></div></div><div className="wizard-final-warning"><HardDrive size={15} /><span>No files are created and no EULA is accepted by this preview.</span></div></div>}
        </div>
        <div className="wizard-footer"><Button kind="quiet" icon={ChevronLeft} onClick={() => currentIndex === 0 ? onClose() : setStep(steps[currentIndex - 1]!.id)}>{currentIndex === 0 ? 'Cancel' : 'Back'}</Button><span className="wizard-footer-note">Step {currentIndex + 1} of {steps.length}</span><Button kind="primary" icon={currentIndex === steps.length - 1 ? Check : ChevronRight} iconSide="right" onClick={next} disabled={step === 'details' && name.trim().length === 0}>{currentIndex === steps.length - 1 ? 'Prepare preview' : 'Continue'}</Button></div>
      </>}
    </section>
  </div>
}

function FieldWizard({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field wizard-field"><span className="field-label">{label}</span>{children}</label>
}
