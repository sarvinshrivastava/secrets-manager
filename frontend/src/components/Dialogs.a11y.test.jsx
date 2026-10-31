import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import AddSingleDialog from "./AddSingleDialog.jsx";
import BulkAddSheet from "./BulkAddSheet.jsx";

describe("dialog semantics", () => {
  it("AddSingleDialog is a labelled modal dialog with associated field labels", () => {
    render(
      <AddSingleDialog
        open
        folders={["A"]}
        defaultFolder="A"
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Add secret" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.className).toContain("overflow-y-auto");
    expect(screen.getByLabelText("Key")).toBeInTheDocument();
    expect(screen.getByLabelText("Value")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" }).className).toContain("p-2");
  });

  it("BulkAddSheet is a labelled modal dialog with a sibling Folder label", () => {
    render(
      <BulkAddSheet
        open
        folders={["A"]}
        defaultFolder="A"
        onCommit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Paste .env" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const label = screen.getByText("Folder", { selector: "label" });
    expect(label).toHaveAttribute("for", "bulk-add-folder");
    expect(document.getElementById("bulk-add-folder")).not.toBeNull();
  });
});
