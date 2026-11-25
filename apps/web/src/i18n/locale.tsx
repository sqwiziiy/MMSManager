import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useAuth } from '../state/use-auth'
import { translateText } from './catalog'
import { UiContext, useUiPreferences } from './locale-context'
import type { UiLanguage, UiPreferences } from './locale-context'

const browserLanguageKey = 'mmsmanager-language'
const defaults: UiPreferences = { language: 'en', theme: 'dark', accent: 'moss', density: 'comfortable', reducedMotion: false }
const renderedText = new WeakMap<Text, { source: string; output: string }>()
const renderedAttributes = new WeakMap<Element, Map<string, { source: string; output: string }>>()
const translatableAttributes = ['aria-label', 'title', 'placeholder', 'alt'] as const
const protectedContent = 'script,style,textarea,code,pre,[data-no-translate],.console-line,.console-output,.log-line,.log-output,.log-message,.player-name,.local-player-names,.file-name,.local-file-name,.local-world-name,.property-key,.property-value'
const protectedAttributes = 'script,style,code,pre,[data-no-translate],.console-line,.console-output,.log-line,.log-output,.log-message,.player-name,.local-player-names,.file-name,.local-file-name,.local-world-name,.property-key,.property-value'

function getBrowserLanguage(): UiLanguage {
  try { return window.localStorage.getItem(browserLanguageKey) === 'ru' ? 'ru' : 'en' }
  catch { return 'en' }
}

function shouldSkip(element: Element | null): boolean {
  return Boolean(element?.closest(protectedContent))
}

function shouldSkipAttributes(element: Element | null): boolean {
  return Boolean(element?.closest(protectedAttributes))
}

function translateTextNode(node: Text, language: UiLanguage) {
  const current = node.nodeValue ?? ''
  const previous = renderedText.get(node)
  const source = previous && current === previous.output ? previous.source : current
  const output = translateText(source, language)
  renderedText.set(node, { source, output })
  if (current !== output) node.nodeValue = output
}

function translateAttributes(element: Element, language: UiLanguage) {
  if (shouldSkipAttributes(element)) return
  let stored = renderedAttributes.get(element)
  if (!stored) { stored = new Map(); renderedAttributes.set(element, stored) }
  for (const name of translatableAttributes) {
    const current = element.getAttribute(name)
    if (current === null) continue
    const previous = stored.get(name)
    const source = previous && current === previous.output ? previous.source : current
    const output = translateText(source, language)
    stored.set(name, { source, output })
    if (current !== output) element.setAttribute(name, output)
  }
}

function translateSubtree(root: Node, language: UiLanguage) {
  if (root instanceof Text) {
    if (!shouldSkip(root.parentElement)) translateTextNode(root, language)
    return
  }
  if (!(root instanceof Element) && !(root instanceof Document)) return
  if (root instanceof Element) {
    translateAttributes(root, language)
    if (shouldSkip(root)) return
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (node instanceof Element && shouldSkip(node)) return NodeFilter.FILTER_REJECT
      if (node instanceof Text) return shouldSkip(node.parentElement) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let node = walker.nextNode()
  while (node) {
    if (node instanceof Text) translateTextNode(node, language)
    else if (node instanceof Element) translateAttributes(node, language)
    node = walker.nextNode()
  }
}

function useDocumentLanguage(language: UiLanguage) {
  useEffect(() => {
    const root = document.getElementById('root')
    document.documentElement.lang = language
    if (!root) return
    let frame = 0
    const observer = new MutationObserver(() => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        translateSubtree(root, language)
      })
    })
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...translatableAttributes] })
    translateSubtree(root, language)
    return () => { observer.disconnect(); if (frame) window.cancelAnimationFrame(frame) }
  }, [language])
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const user = auth.snapshot?.user
  const [browserLanguage, setBrowserLanguage] = useState<UiLanguage>(getBrowserLanguage)
  const [preview, setPreviewState] = useState<Partial<UiPreferences>>({})
  const [, refreshLocaleFormatting] = useState(0)
  const saved = user?.preferences
  const preferences = useMemo<UiPreferences>(() => ({
    language: saved?.language ?? browserLanguage,
    theme: saved?.theme ?? defaults.theme,
    accent: saved?.accent ?? defaults.accent,
    density: saved?.density ?? defaults.density,
    reducedMotion: saved?.reducedMotion ?? defaults.reducedMotion,
    ...preview,
  }), [saved?.language, saved?.theme, saved?.accent, saved?.density, saved?.reducedMotion, browserLanguage, preview])

  useLayoutEffect(() => {
    if (document.documentElement.lang !== preferences.language) {
      document.documentElement.lang = preferences.language
      refreshLocaleFormatting((revision) => revision + 1)
    }
  }, [preferences.language])

  useEffect(() => { setPreviewState({}) }, [user?.id])
  useDocumentLanguage(preferences.language)

  const setPreview = useCallback((next: Partial<UiPreferences>) => setPreviewState((current) => ({ ...current, ...next })), [])
  const clearPreview = useCallback(() => setPreviewState({}), [])
  const setLanguage = useCallback((language: UiLanguage) => {
    if (user) setPreviewState((current) => ({ ...current, language }))
    else {
      setBrowserLanguage(language)
      try { window.localStorage.setItem(browserLanguageKey, language) } catch { /* A private browsing policy may disable storage. */ }
    }
  }, [user])

  const context = useMemo(() => ({ preferences, language: preferences.language, setLanguage, setPreview, clearPreview }), [preferences, setLanguage, setPreview, clearPreview])
  return <UiContext.Provider value={context}>{children}</UiContext.Provider>
}

export function LanguagePicker() {
  const { language, setLanguage } = useUiPreferences()
  const ru = language === 'ru'
  return <label className="language-picker"><span>{ru ? 'Язык' : 'Language'}</span><select aria-label={ru ? 'Язык' : 'Language'} value={language} onChange={(event) => setLanguage(event.target.value as UiLanguage)}><option value="en">English</option><option value="ru">Русский</option></select></label>
}
