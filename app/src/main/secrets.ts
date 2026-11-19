import { safeStorage } from 'electron'

/**
 * Secrets kept in settings.json (calendar links, the OpenRouter key), sealed with the system's keychain where it has one.
 * No keychain (Linux without a secret service): scrambled, not encrypted, so the secret isn't readable at a glance.
 */
export const sealSecret = (plain: string): string =>
  safeStorage.isEncryptionAvailable() ? `k:${safeStorage.encryptString(plain).toString('base64')}` : `b:${Buffer.from(plain).toString('base64')}`
export const openSecret = (sealed: string): string =>
  sealed.startsWith('k:') ? safeStorage.decryptString(Buffer.from(sealed.slice(2), 'base64'))
    : sealed.startsWith('b:') ? Buffer.from(sealed.slice(2), 'base64').toString() : sealed.replace(/^p:/, '')
/** secrets are encrypted here, not only scrambled */
export const secretsEncrypted = (): boolean => safeStorage.isEncryptionAvailable()
