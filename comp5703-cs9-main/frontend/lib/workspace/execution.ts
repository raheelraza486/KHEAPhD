export class ExecutionError extends Error {
  readonly status: number;
  constructor(message: string, status = 504) { super(message); this.status = status; }
}
export function configuredMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 1 && value <= 300_000 ? value : fallback;
}
/** Includes body consumption and services that do not support AbortSignal. */
export async function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  const interruptedError = () => new ExecutionError(signal.reason?.name === 'TimeoutError' ? 'This operation timed out. Your saved draft is unchanged; you can retry.' : 'Operation cancelled. Your saved draft is unchanged.', signal.reason?.name === 'TimeoutError' ? 504 : 499);
  if (signal.aborted) { void operation.catch(() => {}); throw interruptedError(); }
  let onAbort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(interruptedError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([operation, interrupted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}
export function operationSignal(parent: AbortSignal, name: string, fallback: number): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(configuredMs(name, fallback))]);
}
