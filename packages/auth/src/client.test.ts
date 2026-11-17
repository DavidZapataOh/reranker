import { describe, expect, test, vi } from "vitest";

vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "google-client-id.apps.googleusercontent.com");

const { authClient } = await import("./client");

describe("auth client", () => {
  test("One Tap asks Google with the web client the server verifies tokens against", async () => {
    const initialize = vi.fn();
    // Google Identity Services, already loaded, skipping the prompt as it does for a visitor with
    // no Google session.
    vi.stubGlobal("window", {
      document: {},
      googleScriptInitialized: true,
      google: {
        accounts: {
          id: {
            initialize,
            prompt: (listener: (notification: object) => void) =>
              listener({ isSkippedMoment: () => true }),
          },
        },
      },
    });

    await authClient.oneTap();

    expect(initialize).toHaveBeenCalledOnce();
    expect(initialize.mock.calls[0]?.[0]).toMatchObject({
      client_id: "google-client-id.apps.googleusercontent.com",
      context: "signin",
      ux_mode: "popup",
    });
    vi.unstubAllGlobals();
  });
});
