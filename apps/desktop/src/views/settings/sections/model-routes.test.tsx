// @vitest-environment happy-dom
// A saved route edit shows at once: the detail heading and the next Edit
// draft carry the saved value, and every reader of the routes list sees it.
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouteRow } from "./model-providers";

const http = vi.hoisted(() => ({ request: vi.fn(), put: vi.fn() }));
vi.mock("../../../lib/api/request", () => ({ request: http.request }));
vi.mock("../../../lib/api/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/api/settings")>()),
  putGatewayRoute: http.put,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SETTINGS_PATHS } from "../../../lib/api/settings";
import { clearSettingsCaches, useCachedGet } from "../use-cached-api";
import { RouteDetail } from "./model-routes";

const route: RouteRow = {
  model: "auto",
  alias: "Auto",
  provider: "p1",
  enabled: true,
  price_per_mtok_in_usd: 0,
  price_per_mtok_out_usd: 0,
  quota_monthly_usd: null,
  reasoning: false,
  context_window: null,
  max_output_tokens: null,
  temperature: null,
  modalities: [],
};

afterEach(() => {
  cleanup();
  clearSettingsCaches();
  vi.clearAllMocks();
});

describe("route detail", () => {
  it("shows the saved display name in the heading, the edit draft and every routes reader", async () => {
    http.request.mockResolvedValueOnce({ routes: [route] });
    http.request.mockReturnValue(new Promise(() => {}));
    http.put.mockResolvedValue(undefined);
    const list = renderHook(() => useCachedGet<{ routes: RouteRow[] }>(SETTINGS_PATHS.gatewayRoutes));
    render(<RouteDetail model="auto" providers={[]} onChanged={() => {}} onRenamed={() => {}} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Auto" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Auto-qa2" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    await waitFor(() => expect(screen.getByRole("heading", { name: "Auto-qa2" })).toBeTruthy());
    expect(list.result.current.data?.routes[0]?.alias).toBe("Auto-qa2");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Auto-qa2");
  });
});
