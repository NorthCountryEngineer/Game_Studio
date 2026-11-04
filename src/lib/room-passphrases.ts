export const ROOM_PASSPHRASE_HELP = '6–48 characters: letters, numbers, spaces or hyphens. Capitalization and extra spaces do not matter.';
export const ROOM_PASSPHRASE_RETRY_MS = 5 * 60 * 1000;

export function roomPassphraseRetryExpired(startedAt: number | undefined, now = Date.now()): boolean {
  return typeof startedAt !== 'number' || !Number.isFinite(startedAt) || now < startedAt || now - startedAt >= ROOM_PASSPHRASE_RETRY_MS;
}

export function normalizeRoomPassphrase(value: string): string {
  if (typeof value !== 'string' || value.length > 96 || !/^[A-Za-z0-9 -]+$/.test(value)) throw new Error(ROOM_PASSPHRASE_HELP);
  const phrase = value.trim().replace(/ +/g, ' ').toLowerCase();
  if (phrase.length < 6 || phrase.length > 48 || !/[a-z0-9]/.test(phrase)) throw new Error(ROOM_PASSPHRASE_HELP);
  return phrase;
}

export const validateRoomPassphrase = normalizeRoomPassphrase;
