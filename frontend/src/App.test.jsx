import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Mock the API client. The same key exists in two folders — the exact bug the
// composite folder+key identity is meant to fix.
// vi.hoisted so the spy exists before the hoisted vi.mock factory runs.
const { deleteSecret } = vi.hoisted(() => ({
  deleteSecret: vi.fn().mockResolvedValue({ status: "deleted" }),
}));

vi.mock("./api.js", () => ({
  setUnauthorizedHandler: vi.fn(),
  getMe: vi.fn().mockResolvedValue({ role: "write", token_name: "ci" }),
  listSecrets: vi.fn().mockResolvedValue({
    keys: [
      { key: "API_KEY", folder: "Production" },
      { key: "API_KEY", folder: "Staging" },
    ],
  }),
  getFolders: vi.fn().mockResolvedValue({ folders: ["Production", "Staging"] }),
  getSecret: vi
    .fn()
    .mockResolvedValue({ value: "v", created_at: null, folder: "Staging" }),
  createSecret: vi.fn(),
  bulkCreateSecrets: vi.fn(),
  deleteSecret,
}));

import App from "./App.jsx";

describe("App composite folder+key identity", () => {
  beforeEach(() => {
    deleteSecret.mockClear();
    localStorage.clear();
    localStorage.setItem("sm_token_persist", "tok");
  });

  it("deletes the Staging secret, not the Production one, for a shared key", async () => {
    render(<App />);

    // Both rows for API_KEY render once secrets load.
    const stagingDelete = await screen.findByLabelText(
      "Delete API_KEY in Staging",
    );
    expect(
      screen.getByLabelText("Delete API_KEY in Production"),
    ).toBeInTheDocument();

    fireEvent.click(stagingDelete);

    // Confirm dialog shows the folder/key it will act on.
    expect(await screen.findByText("Staging / API_KEY")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteSecret).toHaveBeenCalledTimes(1));
    // Called with the STAGING folder — key alone would have been ambiguous.
    expect(deleteSecret).toHaveBeenCalledWith("tok", "Staging", "API_KEY");
  });
});
