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

// Reveal a value, run a bulk commit, then mask + reveal again — exercising the
// cache-eviction path in handleBulkCommit (updated/added keys must be re-fetched).
async function revealStagingKey(user) {
  await user.click(screen.getByLabelText("Reveal API_KEY in Staging"));
}

async function commitBulkTo(user, folder, response) {
  api.bulkCreateSecrets.mockResolvedValue(response);
  await user.click(screen.getByLabelText("Add options"));
  await user.click(await screen.findByText("Paste .env"));
  const folderInput = await screen.findByDisplayValue("Root");
  fireEvent.change(folderInput, { target: { value: folder } });
  const textarea = await screen.findByPlaceholderText(/paste your \.env/i);
  // NEWKEY collides with nothing, so it is addable and the commit is enabled.
  fireEvent.change(textarea, { target: { value: "NEWKEY=1" } });
  await user.click(
    screen.getByRole("button", {
      name: new RegExp(`Add 1 secret . ${folder}`),
    }),
  );
  await waitFor(() => expect(api.bulkCreateSecrets).toHaveBeenCalled());
  // Sheet closes on success — wait for it before touching the vault behind it.
  await waitFor(() => expect(screen.queryByText("Paste .env")).toBeNull());
}

describe("App reveal cache eviction on bulk commit", () => {
  it("re-fetches an updated key on the next reveal (no stale value)", async () => {
    const user = userEvent.setup();
    api.getSecret
      .mockResolvedValueOnce({
        value: "old",
        created_at: null,
        folder: "Staging",
      })
      .mockResolvedValueOnce({
        value: "new",
        created_at: null,
        folder: "Staging",
      });

    render(<App />);
    await screen.findAllByText("API_KEY");

    await revealStagingKey(user);
    expect(await screen.findByText("old")).toBeInTheDocument();
    expect(api.getSecret).toHaveBeenCalledTimes(1);

    await commitBulkTo(user, "Staging", {
      added: [],
      updated: ["API_KEY"],
      skipped: [],
      invalid: [],
    });

    await user.click(screen.getByLabelText("Mask API_KEY in Staging"));
    await revealStagingKey(user);

    expect(await screen.findByText("new")).toBeInTheDocument();
    expect(screen.queryByText("old")).toBeNull();
    // Cache was evicted, so the second reveal hit the network again.
    expect(api.getSecret).toHaveBeenCalledTimes(2);
    expect(api.getSecret).toHaveBeenLastCalledWith("tok", "Staging", "API_KEY");
  });

  it("re-fetches an added key on the next reveal", async () => {
    const user = userEvent.setup();
    api.getSecret
      .mockResolvedValueOnce({
        value: "old",
        created_at: null,
        folder: "Staging",
      })
      .mockResolvedValueOnce({
        value: "new",
        created_at: null,
        folder: "Staging",
      });

    render(<App />);
    await screen.findAllByText("API_KEY");

    await revealStagingKey(user);
    expect(await screen.findByText("old")).toBeInTheDocument();

    await commitBulkTo(user, "Staging", {
      added: ["API_KEY"],
      updated: [],
      skipped: [],
      invalid: [],
    });

    await user.click(screen.getByLabelText("Mask API_KEY in Staging"));
    await revealStagingKey(user);

    expect(await screen.findByText("new")).toBeInTheDocument();
    expect(api.getSecret).toHaveBeenCalledTimes(2);
  });

  it("does not re-fetch an untouched revealed key when nothing changed", async () => {
    const user = userEvent.setup();
    api.getSecret.mockResolvedValue({
      value: "old",
      created_at: null,
      folder: "Staging",
    });

    render(<App />);
    await screen.findAllByText("API_KEY");

    await revealStagingKey(user);
    expect(await screen.findByText("old")).toBeInTheDocument();
    expect(api.getSecret).toHaveBeenCalledTimes(1);

    // Empty updated + added → no eviction of the revealed key.
    await commitBulkTo(user, "Staging", {
      added: [],
      updated: [],
      skipped: [],
      invalid: [],
    });

    await user.click(screen.getByLabelText("Mask API_KEY in Staging"));
    await revealStagingKey(user);

    // Served from cache — still "old", getSecret not called a second time.
    expect(await screen.findByText("old")).toBeInTheDocument();
    expect(api.getSecret).toHaveBeenCalledTimes(1);
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

describe("App ⌘K search shortcut", () => {
  it("focuses and selects the search box on Cmd+K", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText("API_KEY");

    const search = screen.getByLabelText("Search keys");
    await user.type(search, "API");
    search.blur();
    expect(search).not.toHaveFocus();

    await user.keyboard("{Meta>}k{/Meta}");

    expect(search).toHaveFocus();
    // Selected, so the next keystroke replaces the old term instead of appending.
    expect(search.selectionStart).toBe(0);
    expect(search.selectionEnd).toBe("API".length);
  });

  it("focuses the search box on Ctrl+K for non-mac keyboards", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText("API_KEY");

    const search = screen.getByLabelText("Search keys");
    search.blur();

    await user.keyboard("{Control>}k{/Control}");

    expect(search).toHaveFocus();
  });

  it("preventDefaults the chord so the browser address bar does not claim it", async () => {
    render(<App />);
    await screen.findAllByText("API_KEY");

    const event = new KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores the chord while a modal is open", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText("API_KEY");

    await user.click(screen.getByRole("button", { name: "Add" }));
    // The dialog's labels are not associated with their inputs; target by placeholder.
    const keyField = await screen.findByPlaceholderText("DATABASE_URL");
    keyField.focus();

    await user.keyboard("{Meta>}k{/Meta}");

    // Focus stays inside the dialog rather than jumping behind the overlay.
    expect(keyField).toHaveFocus();
    expect(screen.getByLabelText("Search keys")).not.toHaveFocus();
  });

  it("leaves a bare k keypress alone", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findAllByText("API_KEY");

    const search = screen.getByLabelText("Search keys");
    search.blur();

    await user.keyboard("k");

    expect(search).not.toHaveFocus();
  });
});
