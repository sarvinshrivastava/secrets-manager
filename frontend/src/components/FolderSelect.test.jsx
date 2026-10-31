import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import FolderSelect from "./FolderSelect.jsx";

function Wrapper({ folders = ["A", "B"], initial = "A", ...rest }) {
  const [value, setValue] = useState(initial);
  return (
    <form onSubmit={rest.onSubmit}>
      <FolderSelect value={value} onChange={setValue} folders={folders} {...rest} />
      <output data-testid="val">{value}</output>
    </form>
  );
}

describe("FolderSelect", () => {
  it("picks a folder from the dropdown", async () => {
    const user = userEvent.setup();
    render(<Wrapper />);
    await user.click(screen.getByRole("button", { name: "Folder" }));
    await user.click(screen.getByRole("option", { name: "B" }));
    expect(screen.getByTestId("val")).toHaveTextContent("B");
  });

  it("does not invent Root for a scoped token's folder list", async () => {
    const user = userEvent.setup();
    render(<Wrapper folders={["Prod"]} initial="Prod" />);
    await user.click(screen.getByRole("button", { name: "Folder" }));
    expect(screen.queryByRole("option", { name: "Root" })).toBeNull();
  });

  it("always shows the current value even when it is not in the list", () => {
    render(<Wrapper folders={["A"]} initial="Z" />);
    expect(screen.getByRole("button", { name: "Folder" })).toHaveTextContent("Z");
  });

  it("new folder accepts a name with a space and Enter does not submit the form", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e) => e.preventDefault());
    render(<Wrapper onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: "Folder" }));
    await user.click(screen.getByRole("option", { name: "+ New folder…" }));
    const input = screen.getByLabelText("New folder name");
    await user.type(input, "My Team{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("val")).toHaveTextContent("My Team");
    // back to the dropdown showing the new folder
    expect(screen.getByRole("button", { name: "Folder" })).toHaveTextContent("My Team");
  });

  it("flags an invalid new folder name", async () => {
    const user = userEvent.setup();
    render(<Wrapper startInNew initial="" />);
    await user.type(screen.getByLabelText("New folder name"), "..");
    expect(screen.getByText(/1-128 chars/)).toBeInTheDocument();
  });

  it("returns focus to the select button after Enter, Escape and Cancel", async () => {
    const user = userEvent.setup();
    render(<Wrapper startInNew initial="" />);
    await user.type(screen.getByLabelText("New folder name"), "{Enter}");
    // empty name: stays in the input
    expect(screen.getByLabelText("New folder name")).toHaveFocus();
    await user.type(screen.getByLabelText("New folder name"), "Team{Enter}");
    expect(screen.getByRole("button", { name: "Folder" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Folder" }));
    await user.click(screen.getByRole("option", { name: "+ New folder…" }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Folder" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Folder" }));
    await user.click(screen.getByRole("option", { name: "+ New folder…" }));
    await user.click(screen.getByRole("button", { name: "Cancel new folder" }));
    expect(screen.getByRole("button", { name: "Folder" })).toHaveFocus();
  });

  it("marks an invalid name with aria-invalid and an alert hint it describes", async () => {
    const user = userEvent.setup();
    render(<Wrapper startInNew initial="" />);
    const input = screen.getByLabelText("New folder name");
    expect(input).not.toHaveAttribute("aria-invalid");
    await user.type(input, "..");
    const hint = screen.getByRole("alert");
    expect(hint).toHaveTextContent(/1-128 chars/);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", hint.id);
  });

  it("Escape in the new-folder input returns to the list without closing anything", async () => {
    const user = userEvent.setup();
    const onKey = vi.fn();
    window.addEventListener("keydown", onKey);
    render(<Wrapper startInNew />);
    fireEvent.keyDown(screen.getByLabelText("New folder name"), { key: "Escape" });
    expect(screen.getByRole("button", { name: "Folder" })).toBeInTheDocument();
    window.removeEventListener("keydown", onKey);
    void user;
  });
});
