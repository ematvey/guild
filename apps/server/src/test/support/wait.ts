// Polls a probe until it holds; the shared wait for tests that observe a
// background effect (a turn settling, a row landing).

export async function waitFor(probe: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("waitFor timed out");
}
