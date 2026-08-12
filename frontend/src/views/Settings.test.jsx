import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock the API client. createToken is the one under test; listTokens resolves
// so the on-mount load settles cleanly.
const api = vi.hoisted(() => ({
  exportSecrets: vi.fn(),
  listTokens: vi.fn(),
  createToken: vi.fn(),
  revokeToken: vi.fn(),
  rotateToken: vi.fn(),
}));

vi.mock("../api.js", () => api);

// Mock react-hot-toast so we can assert on the toast calls without rendering.
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("react-hot-toast", () => ({ toast, Toaster: () => null }));

import Settings from "./Settings.jsx";

function renderSettings(props = {}) {
  return render(
    <Settings
      tokenName="ci"
      role="write"
      token="tok"
      folders={["Root", "ServiceA", "ServiceB"]}
      defaultFolder="Root"
      onDefaultFolderChange={() => {}}
      onLogout={() => {}}
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listTokens.mockResolvedValue({ tokens: [] });
  api.createToken.mockResolvedValue({
    name: "ci-reader",
    token: "sm_secret_value",
    scope: "*",
  });
});

async function settleMount() {
  await waitFor(() => expect(api.listTokens).toHaveBeenCalled());
}

describe("Settings create-token scope wiring", () => {
  it("sends scope arg undefined when 'All folders' stays checked", async () => {
    const user = userEvent.setup();
    renderSettings();
    await settleMount();

    await user.type(
      screen.getByPlaceholderText("name e.g. ci-reader"),
      "ci-reader",
    );
    await user.click(screen.getByRole("button", { name: "Create token" }));

    await waitFor(() => expect(api.createToken).toHaveBeenCalledTimes(1));
    // (token, name, role, expiresInSeconds, scope) — scope must be undefined,
    // NOT [] or ["*"], so the backend applies its all-folders default.
    expect(api.createToken).toHaveBeenCalledWith(
      "tok",
      "ci-reader",
      "read",
      undefined,
      undefined,
    );
    expect(api.createToken.mock.calls[0][4]).toBeUndefined();
  });

  it("sends the exact picked folders when an explicit subset is chosen", async () => {
    const user = userEvent.setup();
    renderSettings();
    await settleMount();

    await user.type(
      screen.getByPlaceholderText("name e.g. ci-reader"),
      "scoped",
    );
    // Uncheck all-folders → folder checkboxes appear.
    await user.click(screen.getByLabelText("All folders (*)"));
    await user.click(screen.getByLabelText("Root"));
    await user.click(screen.getByLabelText("ServiceA"));
    await user.click(screen.getByRole("button", { name: "Create token" }));

    await waitFor(() => expect(api.createToken).toHaveBeenCalledTimes(1));
    expect(api.createToken.mock.calls[0][4]).toEqual(["Root", "ServiceA"]);
  });

  it("guards an empty selection: no create call, guard toast fires", async () => {
    const user = userEvent.setup();
    renderSettings();
    await settleMount();

    await user.type(
      screen.getByPlaceholderText("name e.g. ci-reader"),
      "empty",
    );
    await user.click(screen.getByLabelText("All folders (*)"));
    // Tick nothing.
    await user.click(screen.getByRole("button", { name: "Create token" }));

    expect(api.createToken).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Pick at least one folder or choose all folders",
    );
  });

  it("surfaces a 403 scope error and does not reset the form", async () => {
    const user = userEvent.setup();
    api.createToken.mockRejectedValue(
      new Error("Cannot grant scope beyond your own"),
    );
    renderSettings();
    await settleMount();

    const nameInput = screen.getByPlaceholderText("name e.g. ci-reader");
    await user.type(nameInput, "ci-reader");
    await user.click(screen.getByRole("button", { name: "Create token" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Create failed: Cannot grant scope beyond your own",
      ),
    );
    // Form not reset — the typed name survives so the operator can retry.
    expect(nameInput).toHaveValue("ci-reader");
  });
});
