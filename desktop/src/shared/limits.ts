/** The longest text each field takes. Main checks the same limits (ipc.ts), so ordinary typing never reaches "Bad input". */
export const LIMITS = { topic: 200, known: 500, title: 200, words: 2000, note: 20_000 } as const;
