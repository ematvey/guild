// Polls a probe until it holds; the shared wait for tests that observe a
// background effect (a turn settling, a row landing).

export async function waitFor(
  probe: () => boolean | Promise<boolean>,
  timeoutMs = 60_000,
  intervalMs = 100,
  message = "waitFor timed out",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(message);
}
