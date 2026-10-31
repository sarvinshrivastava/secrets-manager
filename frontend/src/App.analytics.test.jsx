import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({
  setUnauthorizedHandler: vi.fn(),
  getMe: vi.fn(),
  listSecrets: vi.fn(),
  getFolders: vi.fn(),
  getSecret: vi.fn(),
  createSecret: vi.fn(),
  bulkCreateSecrets: vi.fn(),
  editSecret: vi.fn(),
  deleteSecret: vi.fn(),
  getAnalytics: vi.fn(),
}));
vi.mock("./api.js", () => api);

import App from "./App.jsx";

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem("sm_token_persist", "tok");
  api.getMe.mockResolvedValue({ role: "write", token_name: "ci" });
  api.listSecrets.mockResolvedValue({ keys: [{ key: "A", folder: "Prod" }] });
  api.getFolders.mockResolvedValue({ folders: ["Prod"] });
  api.getAnalytics.mockResolvedValue({
    range: "7d",
    since: "2026-10-25T00:00:00.000Z",
    generated_at: "2026-10-31T10:30:00.000Z",
    retention_days: 90,
    clamped: false,
    admin: false,
    secrets: { total: 1, folders: [{ folder: "Prod", count: 1 }] },
    tokens: null,
    activity: null,
    top_keys: null,
    top_tokens: null,
    unread: null,
  });
});

describe("App: Analytics tab", () => {
  it("opens the Analytics view from the nav and fetches the 7d range", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Analytics" }));
    expect(await screen.findByText("Secrets per folder")).toBeInTheDocument();
    expect(api.getAnalytics).toHaveBeenCalledWith("tok", "7d");
    await user.click(screen.getByRole("button", { name: "Vault" }));
    expect(screen.queryByText("Secrets per folder")).toBeNull();
  });
});
