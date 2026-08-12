import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock the whole API client. Every fn is hoisted so individual tests can
// reconfigure a resolved/rejected value per case.
const api = vi.hoisted(() => ({
  setUnauthorizedHandler: vi.fn(),
  getMe: vi.fn(),
  listSecrets: vi.fn(),
  getFolders: vi.fn(),
  getSecret: vi.fn(),
  createSecret: vi.fn(),
  bulkCreateSecrets: vi.fn(),
  deleteSecret: vi.fn(),
}));

vi.mock("./api.js", () => api);

import App from "./App.jsx";

// The same key exists in two folders — the exact bug the composite folder+key
// identity is meant to fix.
function defaultSecrets() {
  return {
    keys: [
      { key: "API_KEY", folder: "Production" },
      { key: "API_KEY", folder: "Staging" },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("sm_token_persist", "tok");

  api.getMe.mockResolvedValue({ role: "write", token_name: "ci" });
  api.listSecrets.mockResolvedValue(defaultSecrets());
  api.getFolders.mockResolvedValue({ folders: ["Production", "Staging"] });
  api.getSecret.mockResolvedValue({
    value: "v",
    created_at: null,
    folder: "Staging",
  });
  api.createSecret.mockResolvedValue({ status: "created" });
  api.bulkCreateSecrets.mockResolvedValue({
    added: [],
    updated: [],
    skipped: [],
    invalid: [],
  });
  api.deleteSecret.mockResolvedValue({ status: "deleted" });
});

describe("App composite folder+key identity", () => {
  it("deletes the Staging secret, not the Production one, for a shared key", async () => {
    render(<App />);

    const stagingDelete = await screen.findByLabelText(
      "Delete API_KEY in Staging",
    );
    expect(
      screen.getByLabelText("Delete API_KEY in Production"),
    ).toBeInTheDocument();

    fireEvent.click(stagingDelete);

    expect(await screen.findByText("Staging / API_KEY")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(api.deleteSecret).toHaveBeenCalledTimes(1));
    // Called with the STAGING folder — key alone would have been ambiguous.
    expect(api.deleteSecret).toHaveBeenCalledWith("tok", "Staging", "API_KEY");
  });
});

describe("App role-gated controls", () => {
  it("renders no delete or add controls for a read-only token", async () => {
    api.getMe.mockResolvedValue({ role: "read", token_name: "reader" });
    render(<App />);

    await screen.findAllByText("API_KEY");
    expect(screen.queryByLabelText(/^Delete /)).toBeNull();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.queryByLabelText("Add options")).toBeNull();
  });

  it("renders delete and add controls for a write token", async () => {
    render(<App />);

    await screen.findAllByText("API_KEY");
    expect(screen.getAllByLabelText(/^Delete /).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
    expect(screen.getByLabelText("Add options")).toBeInTheDocument();
  });
});

describe("App unauthorized handling", () => {
  it("clears the stored token and returns to Login when the handler fires", async () => {
    render(<App />);
    await screen.findAllByText("API_KEY");

    // App registers exactly one handler via setUnauthorizedHandler; api.js would
    // invoke it on a 401. Drive it directly.
    const call = api.setUnauthorizedHandler.mock.calls.find(
      (c) => typeof c[0] === "function",
    );
    expect(call).toBeTruthy();
    act(() => call[0]());

    expect(await screen.findByLabelText("Access token")).toBeInTheDocument();
    expect(localStorage.getItem("sm_token_persist")).toBeNull();
    expect(sessionStorage.getItem("sm_token_session")).toBeNull();
  });
});

describe("App bulk-commit summary", () => {
  it("maps the bulk response counts into the toast summary", async () => {
    const user = userEvent.setup();
    api.bulkCreateSecrets.mockResolvedValue({
      added: ["a"],
      updated: ["b"],
      skipped: ["c"],
      invalid: [{ key: "d" }],
    });

    render(<App />);
    await screen.findAllByText("API_KEY");

    // Open the Paste .env sheet via the Add menu.
    await user.click(screen.getByLabelText("Add options"));
    await user.click(await screen.findByText("Paste .env"));

    const textarea = await screen.findByPlaceholderText(/paste your \.env/i);
    // Default folder is Root; NEWKEY does not collide, so it is addable.
    fireEvent.change(textarea, { target: { value: "NEWKEY=1" } });

    await user.click(
      screen.getByRole("button", { name: /Add 1 secret → Root/ }),
    );

    await waitFor(() => expect(api.bulkCreateSecrets).toHaveBeenCalledTimes(1));

    expect(
      await screen.findByText(
        (t) =>
          t.includes("Added 1") &&
          t.includes("updated 1") &&
          t.includes("skipped 1") &&
          t.includes("invalid 1"),
      ),
    ).toBeInTheDocument();
  });
});

describe("App folder union", () => {
  it("unions server folders with folders actually in use", async () => {
    api.getFolders.mockResolvedValue({ folders: ["ServerOnly"] });
    api.listSecrets.mockResolvedValue({
      keys: [{ key: "K", folder: "UsedOnly" }],
    });

    render(<App />);

    // Both the server-declared folder and the in-use folder appear as chips.
    // "UsedOnly" shows twice — the filter chip and the row's folder chip.
    expect(await screen.findByText("ServerOnly")).toBeInTheDocument();
    expect(screen.getAllByText("UsedOnly").length).toBeGreaterThan(0);
  });
});
