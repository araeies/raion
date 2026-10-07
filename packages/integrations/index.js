import { fileURLToPath } from 'node:url';

/** Directory containing the first-party integration packages (one folder per integration). */
export const builtinIntegrationsDir = fileURLToPath(new URL('.', import.meta.url));
