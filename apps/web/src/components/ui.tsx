import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: 'primary' | 'secondary' | 'quiet' | 'danger'
  icon?: LucideIcon
  iconSide?: 'left' | 'right'
}

export function Button({ children, kind = 'secondary', icon: Icon, iconSide = 'left', className = '', ...props }: ButtonProps) {
  return (
    <button className={`button button-${kind} ${className}`} {...props}>
      {Icon && iconSide === 'left' && <Icon size={16} strokeWidth={1.8} aria-hidden="true" />}
      <span>{children}</span>
      {Icon && iconSide === 'right' && <Icon size={16} strokeWidth={1.8} aria-hidden="true" />}
    </button>
  )
}

export function IconButton({ icon: Icon, label, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string }) {
  return (
    <button className={`icon-button ${className}`} aria-label={label} title={label} {...props}>
      <Icon size={18} strokeWidth={1.7} aria-hidden="true" />
    </button>
  )
}

export function Card({ children, className = '', ...props }: PropsWithChildren<{ className?: string; onClick?: () => void }>) {
  return <section className={`card ${className}`} {...props}>{children}</section>
}

export function Badge({ children, tone = 'neutral', className = '' }: PropsWithChildren<{ tone?: 'neutral' | 'good' | 'warn' | 'danger' | 'accent'; className?: string }>) {
  return <span className={`badge badge-${tone} ${className}`}>{children}</span>
}

export function PreviewFlag({ children = 'Demo data' }: PropsWithChildren) {
  return <span className="preview-flag"><span className="preview-flag-dot" />{children}</span>
}

export function PageHeading({ title, description, eyebrow, actions }: { title: string; description?: string; eyebrow?: string; actions?: ReactNode }) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  )
}

export function SectionHeading({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  )
}

export function ComingSoon({ className = '' }: { className?: string }) {
  return <span className={`coming-soon ${className}`}>Coming soon</span>
}

export function DisabledButton({ children, icon: Icon, kind = 'secondary' }: PropsWithChildren<{ icon?: LucideIcon; kind?: ButtonProps['kind'] }>) {
  return <div className="disabled-action"><Button disabled title="Coming soon" icon={Icon} kind={kind}>{children}</Button><ComingSoon /></div>
}

export function StatusDot({ status }: { status: 'Online' | 'Offline' | 'Starting' }) {
  return <span className={`status-dot status-${status.toLowerCase()}`} aria-label={status} />
}

export function EmptyNote({ icon: Icon, title, detail }: { icon: LucideIcon; title: string; detail: string }) {
  return <div className="empty-note"><span className="empty-note-icon"><Icon size={19} /></span><div><strong>{title}</strong><p>{detail}</p></div></div>
}

export function Field({ label, hint, children }: PropsWithChildren<{ label: string; hint?: string }>) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>
}

export function SwitchPreview({ checked, label }: { checked: boolean; label: string }) {
  return <span className="switch-preview" role="img" aria-label={`${label}, ${checked ? 'on' : 'off'}, preview`}><span className={checked ? 'switch-thumb checked' : 'switch-thumb'} /></span>
}
