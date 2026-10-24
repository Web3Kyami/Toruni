/** Waits briefly for a stopped scorer's current database/provider work to settle. */
export async function drainWorkerTasks(tasks: Array<Promise<unknown> | null>, timeoutMs: number): Promise<boolean> {
  const pending = tasks.filter((task): task is Promise<unknown> => task !== null);
  if (pending.length === 0) return true;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      Promise.allSettled(pending).then(() => true),
      new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
