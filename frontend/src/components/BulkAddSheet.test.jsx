import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import BulkAddSheet from "./BulkAddSheet.jsx";

function setup(overrides = {}) {
  const onCommit = vi.fn().mockResolvedValue({});
  const onClose = vi.fn();
  render(
    <BulkAddSheet
      open
      folders={["Root", "Production"]}
      defaultFolder="Root"
      secrets={[{ key: "EXISTING_KEY", folder: "Root" }]}
      busy={false}
      onCommit={onCommit}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onCommit, onClose };
}

describe("BulkAddSheet verification ledger", () => {
  it("renders a status chip per parsed line", () => {
    setup();
    const textarea = screen.getByPlaceholderText(/paste your \.env/i);
    fireEvent.change(textarea, {
      target: {
        value: ["NEW_KEY=abc", "EXISTING_KEY=xyz", "bad-key=1"].join("\n"),
      },
    });

    // add for the fresh key, exists for the vault key, invalid for the bad key.
    expect(screen.getByText("add")).toBeInTheDocument();
    expect(screen.getByText("exists")).toBeInTheDocument();
    expect(screen.getByText("invalid")).toBeInTheDocument();
    // The invalid reason is surfaced.
    expect(screen.getByText(/must match/i)).toBeInTheDocument();
  });

  it("counts only addable rows in the commit button and excludes exists by default", () => {
    setup();
    const textarea = screen.getByPlaceholderText(/paste your \.env/i);
    fireEvent.change(textarea, {
      target: { value: ["A=1", "B=2", "EXISTING_KEY=z"].join("\n") },
    });
    // A and B are addable; EXISTING_KEY is skipped unless overwrite toggled.
    expect(
      screen.getByRole("button", { name: /Add 2 secrets → Root/ }),
    ).toBeInTheDocument();
  });

  it("includes an exists row (and its key in overwrite) once its toggle is on", () => {
    const { onCommit } = setup();
    const textarea = screen.getByPlaceholderText(/paste your \.env/i);
    fireEvent.change(textarea, {
      target: { value: ["A=1", "EXISTING_KEY=z"].join("\n") },
    });

    fireEvent.click(screen.getByLabelText(/overwrite/i));
    const commit = screen.getByRole("button", { name: /Add 2 secrets → Root/ });
    fireEvent.click(commit);

    expect(onCommit).toHaveBeenCalledTimes(1);
    const arg = onCommit.mock.calls[0][0];
    expect(arg.folder).toBe("Root");
    expect(arg.overwrite).toEqual(["EXISTING_KEY"]);
    expect(arg.secrets).toEqual(
      expect.arrayContaining([
        { key: "A", value: "1" },
        { key: "EXISTING_KEY", value: "z" },
      ]),
    );
  });

  it("masks values unless 'show values' is toggled", () => {
    setup();
    const textarea = screen.getByPlaceholderText(/paste your \.env/i);
    fireEvent.change(textarea, { target: { value: "SECRET=supersecret" } });

    expect(screen.queryByText("supersecret")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/show values/i));
    expect(screen.getByText("supersecret")).toBeInTheDocument();
  });
});

describe("BulkAddSheet folder-scoped exists detection", () => {
  // A key present in folder A must NOT be flagged as existing when pasting into
  // folder B, and MUST be flagged when the folder selector switches to A.
  it("scopes the exists check to the selected folder", () => {
    render(
      <BulkAddSheet
        open
        folders={["A", "B"]}
        defaultFolder="B"
        secrets={[{ key: "K", folder: "A" }]}
        busy={false}
        onCommit={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const textarea = screen.getByPlaceholderText(/paste your \.env/i);
    fireEvent.change(textarea, { target: { value: "K=1" } });

    // Folder B selected: K exists only in A, so here it is addable.
    expect(screen.getByText("add")).toBeInTheDocument();
    expect(screen.queryByText("exists")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Add 1 secret → B/ }),
    ).toBeInTheDocument();

    // Switch the folder selector to A: now K collides and is flagged exists.
    fireEvent.change(screen.getByDisplayValue("B"), { target: { value: "A" } });
    expect(screen.getByText("exists")).toBeInTheDocument();
    expect(screen.queryByText("add")).toBeNull();
    // The addable count drops to zero (exists is skipped unless overwritten).
    expect(
      screen.getByRole("button", { name: /Add 0 secrets → A/ }),
    ).toBeInTheDocument();
  });
});
