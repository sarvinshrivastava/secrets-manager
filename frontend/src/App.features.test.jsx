import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
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
}));
vi.mock("./api.js", () => api);

import App from "./App.jsx";

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem("sm_token_persist", "tok");
  api.getMe.mockResolvedValue({ role: "write", token_name: "ci" });
  api.listSecrets.mockResolvedValue({
    keys: [
      { key: "API_KEY", folder: "Prod" },
      { key: "DB_URL", folder: "Staging" },
    ],
  });
  api.getFolders.mockResolvedValue({ folders: ["Prod", "Staging"] });
  api.getSecret.mockResolvedValue({ value: "v", created_at: null, folder: "Prod" });
  api.createSecret.mockResolvedValue({ status: "ok" });
  api.editSecret.mockResolvedValue({ status: "ok", key: "API_KEY_2", folder: "Prod" });
});
afterEach(() => vi.restoreAllMocks());

describe("App: edit secret", () => {
  it("renames via PATCH (changed fields only) then refreshes", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByLabelText("Edit API_KEY in Prod"));
    const key = await screen.findByLabelText("Key");
    await user.clear(key);
    await user.type(key, "API_KEY_2");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(api.editSecret).toHaveBeenCalledWith("tok", "Prod", "API_KEY", {
        key: "API_KEY_2",
      }),
    );
    // dialog closes and the list is refreshed
    await waitFor(() => expect(screen.queryByLabelText("Edit secret")).toBeNull());
    expect(api.listSecrets.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(api.createSecret).not.toHaveBeenCalled();
    expect(api.deleteSecret).not.toHaveBeenCalled();
  });

  it("a failed list refresh after a successful edit is not reported as 'Save failed'", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByLabelText("Edit API_KEY in Prod"));
    const key = await screen.findByLabelText("Key");
    await user.type(key, "X");
    api.listSecrets.mockRejectedValueOnce(new Error("network down"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.editSecret).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByLabelText("Edit secret")).toBeNull());
    expect(screen.queryByText(/Save failed/)).toBeNull();
    expect(await screen.findByText(/couldn't refresh/i)).toBeInTheDocument();
  });

  it("shows a 409 collision inline and keeps the dialog open", async () => {
    const user = userEvent.setup();
    api.editSecret.mockRejectedValueOnce(
      new Error("Secret 'DB_URL' already exists in folder 'Prod'"),
    );
    render(<App />);
    await user.click(await screen.findByLabelText("Edit API_KEY in Prod"));
    await user.type(await screen.findByLabelText("Key"), "X");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already exists/);
    expect(screen.getByLabelText("Edit secret")).toBeInTheDocument();
  });

  it("read-only tokens get no edit button or New folder chip", async () => {
    api.getMe.mockResolvedValue({ role: "read", token_name: "ro" });
    render(<App />);
    await screen.findByText("API_KEY");
    expect(screen.queryByLabelText(/^Edit /)).toBeNull();
    expect(screen.queryByRole("button", { name: /New folder/ })).toBeNull();
  });
});

describe("App: New folder", () => {
  it("opens Add secret with an empty folder-name box and pushes one history entry", async () => {
    const user = userEvent.setup();
    const pushSpy = vi.spyOn(window.history, "pushState");
    render(<App />);
    await screen.findByText("API_KEY");
    pushSpy.mockClear();
    await user.click(screen.getByRole("button", { name: /New folder/ }));
    const name = await screen.findByLabelText("New folder name");
    expect(name).toHaveValue("");
    expect(pushSpy).toHaveBeenCalledTimes(1);
    await user.type(name, "Brand New");
    await user.type(screen.getByPlaceholderText("DATABASE_URL"), "K");
    await user.type(screen.getByPlaceholderText("value…"), "v");
    await user.click(screen.getByRole("button", { name: "Add secret" }));
    await waitFor(() =>
      expect(api.createSecret).toHaveBeenCalledWith("tok", "K", "v", "Brand New"),
    );
  });

  it("Back on the dirty Add dialog asks before discarding", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("API_KEY");
    await user.click(screen.getByRole("button", { name: /New folder/ }));
    await user.type(await screen.findByPlaceholderText("DATABASE_URL"), "K");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    expect(await screen.findByText("Discard changes?")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("DATABASE_URL")).toBeInTheDocument();
  });
});

describe("App: theme", () => {
  it("follows the browser live in auto, ignoring a legacy stored theme", async () => {
    localStorage.setItem("sm_theme", "light");
    globalThis.__setSystemDark(true);
    render(<App />);
    await screen.findByText("API_KEY");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    act(() => globalThis.__setSystemDark(false));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("cycles auto -> light -> dark and stops following the browser when pinned", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("API_KEY");
    const btn = () => screen.getByRole("button", { name: /^Theme:/ });
    expect(btn()).toHaveAttribute("aria-label", expect.stringContaining("auto"));
    await user.click(btn()); // light
    expect(localStorage.getItem("sm_theme_pref")).toBe("light");
    act(() => globalThis.__setSystemDark(true));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(globalThis.__mediaListenerCount()).toBe(0);
    await user.click(btn()); // dark
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    await user.click(btn()); // auto again
    expect(localStorage.getItem("sm_theme_pref")).toBe("auto");
  });
});
