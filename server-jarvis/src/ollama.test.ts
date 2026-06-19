});


function mockOllamaShow(capabilities: string[] | null) {
  (globalThis as any).fetch = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "http://localhost:11434/api/show") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.model !== "qwen3.5-9b:latest") {
        return Response.json({ error: "model not found" }, { status: 404 });
      }
      if (capabilities === null) {
        return Response.json({ error: "boom" }, { status: 500 });
      }
      return Response.json({ capabilities });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

describe("checkOllamaModelSupportsTools", () => {
  test("returns true when /api/show reports a tools capability", async () => {
    mockOllamaShow(["completion", "tools", "vision"]);

    expect(await checkOllamaModelSupportsTools("http://localhost:11434", "qwen3.5-9b:latest")).toBe(true);
  });

  test("returns false when /api/show omits the tools capability", async () => {
    mockOllamaShow(["completion", "vision"]);

    expect(await checkOllamaModelSupportsTools("http://localhost:11434", "qwen3.5-9b:latest")).toBe(false);
  });

  test("returns false when /api/show errors", async () => {
    mockOllamaShow(null);

    expect(await checkOllamaModelSupportsTools("http://localhost:11434", "qwen3.5-9b:latest")).toBe(false);
  });
});