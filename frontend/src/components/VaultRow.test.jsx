import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import VaultRow from "./VaultRow.jsx";

const LONG = "GWORKSPACE_MCP_SCOPED_TOKEN_INSTINCT_AND_SOME_MORE_LETTERS_TO_OVERFLOW";

function renderRow(role = "write") {
  const secret = { key: LONG, folder: "A-very-long-folder-name-that-overflows", id: "x" };
  render(
    <table>
      <tbody>
        <VaultRow
          secret={secret}
          createdAt={null}
          reveal={null}
          role={role}
          busy={false}
          onCopy={() => {}}
          onReveal={() => {}}
          onMask={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
        />
      </tbody>
    </table>,
  );
}

describe("VaultRow", () => {
  it("truncates the key and keeps the full name in a title", () => {
    renderRow();
    const key = screen.getByText(LONG);
    expect(key).toHaveClass("truncate");
    expect(key).toHaveClass("block");
    expect(key).toHaveAttribute("title", LONG);
  });

  it("truncates the folder inside its chip (ellipsis needs the inner span)", () => {
    renderRow();
    const inner = screen.getByText("A-very-long-folder-name-that-overflows");
    expect(inner).toHaveClass("truncate");
    expect(inner.parentElement).toHaveAttribute(
      "title",
      "A-very-long-folder-name-that-overflows",
    );
  });

  it("shows Edit and Delete for write tokens only", () => {
    renderRow("write");
    expect(screen.getByLabelText(/^Edit /)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Delete /)).toBeInTheDocument();
  });

  it("hides Edit for read tokens", () => {
    renderRow("read");
    expect(screen.queryByLabelText(/^Edit /)).toBeNull();
  });

  it("hides actions only where hover exists and titles copy plainly", () => {
    renderRow();
    const copy = screen.getByRole("button", { name: /^Copy / });
    expect(copy).toHaveAttribute("title", "Copy value");
    expect(copy.parentElement.className).toContain("[@media(hover:hover)]:opacity-0");
    expect(copy.parentElement.className).toContain("focus-within:opacity-100");
    expect(copy.parentElement.className).not.toContain("sm:opacity-0");
  });
});
