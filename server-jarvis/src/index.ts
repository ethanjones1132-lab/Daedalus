let bridgeProcess: ReturnType<typeof spawn> | null = null;

async function isBridgeListening(): Promise<boolean> {
  try {
    const { connect } = await import("net");
    return await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port: BRIDGE_PORT, timeout: 1000 }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(1000, () => {
        socket.destroy();
        resolve(false);
      });
    });
  } catch {
    return false;
  }
}

async function waitForBridgeState(expected: boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await isBridgeListening()) === expected) return true;
    await Bun.sleep(150);
  }
  return (await isBridgeListening()) === expected;
}