export function BrandGlyph({ size = 'regular' }: { size?: 'regular' | 'large' }) {
  return <span className={`brand-glyph${size === 'large' ? ' brand-glyph-large' : ''}`} aria-hidden="true"><i /><i /><i /><i /></span>
}
