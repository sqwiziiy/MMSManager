import { describe, expect, it } from 'vitest'
import { englishCatalog, isCatalogText, isLocalizedText, pluralCount, russianCatalog, supplementalPhrasePairs, translateText } from './catalog'

describe('English and Russian interface catalog', () => {
  it('keeps matching keys and translates accessible interface messages', () => {
    expect(Object.keys(russianCatalog)).toEqual(Object.keys(englishCatalog))
    expect(translateText('  Dashboard\n', 'ru')).toBe('  Обзор\n')
    expect(translateText('Dashboard', 'en')).toBe('Dashboard')
    expect(translateText('my-world/seed_123', 'ru')).toBe('my-world/seed_123')
    expect(isCatalogText('Language & appearance')).toBe(true)
  })

  it('uses locale plural rules and number formatting', () => {
    const forms = { en: ['server', 'servers'] as [string, string], ru: ['сервер', 'сервера', 'серверов'] as [string, string, string] }
    expect(pluralCount(1, 'ru', forms)).toBe('1 сервер')
    expect(pluralCount(3, 'ru', forms)).toBe('3 сервера')
    expect(pluralCount(12, 'ru', forms)).toBe('12 серверов')
    expect(pluralCount(2, 'en', forms)).toBe('2 servers')
  })

  it('requires Russian targets and translates parameterized accessibility copy', () => {
    expect(isLocalizedText('Dashboard', 'ru')).toBe(false)
    expect(isLocalizedText('Обзор', 'ru')).toBe(true)
    expect(translateText('3 samples', 'ru')).toBe('3 образца')
    expect(translateText('Reset password for stage-admin', 'ru')).toBe('Сбросить пароль для stage-admin')
    expect(translateText('Saved Java 21 · recheck on save', 'ru')).toBe('Сохранённая Java 21 · повторная проверка при сохранении')
    expect(translateText('MB', 'ru')).toBe('МБ')
    const calendarDay = translateText('понедельник, 2 ноября 2026 г.. No data', 'ru')
    expect(calendarDay).toBe('понедельник, 2 ноября 2026 г.. Нет данных')
    expect(isLocalizedText(calendarDay, 'ru')).toBe(true)
    expect(isLocalizedText('25 нояб. 2026 г.. No data', 'ru')).toBe(false)
  })

  it('keeps supplemental route phrases paired, while preserving literal property values', () => {
    const english = supplementalPhrasePairs.map(([source]) => source)
    expect(new Set(english).size).toBe(english.length)
    expect(supplementalPhrasePairs.every(([source, target]) => Boolean(source.trim() && target.trim()))).toBe(true)
    expect(translateText('Personal', 'ru')).toBe('Личные настройки')
    expect(translateText('Language changes menus, settings and help text. Minecraft values and user-entered names stay unchanged. Appearance changes preview immediately and are saved to your account.', 'ru')).toContain('Язык меняет меню')
  })

  it('translates ZIP import and server removal failures, including variable details', () => {
    expect(translateText('The archive contains an absolute or traversing path.', 'ru')).toContain('абсолютный путь')
    expect(translateText('This server requires Java 17 or newer. Choose a compatible installed runtime.', 'ru')).toContain('Java 17 или новее')
    expect(translateText('The archive exceeds the 20,000 entry limit.', 'ru')).toContain('20,000 элементов')
    expect(translateText('Type the exact server name to confirm this action.', 'ru')).toContain('точное название сервера')
  })
})
