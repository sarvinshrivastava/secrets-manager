import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EditSecretDialog from "./EditSecretDialog.jsx";

function setup(overrides = {}) {
  const props = {
    open: true,
    secret: { key: "API_KEY", folder: "Prod", id: "Prod API_KEY" },
    folders: ["Prod", "Staging"],
    busy: false,
    onLoadValue: vi.fn().mockResolvedValue("old-value"),
    onSubmit: vi.fn().mockResolvedValue(null),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<EditSecretDialog {...props} />);
  return props;
}

describe("EditSecretDialog", () => {
  it("sends only the changed fields: rename only omits value and folder", async () => {
    const user = userEvent.setup();
    const props = setup();
    const key = screen.getByLabelText("Key");
    await user.clear(key);
    await user.type(key, "API_KEY_V2");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(props.onSubmit).toHaveBeenCalledWith({ key: "API_KEY_V2" });
  });

  it("moves folder through the dropdown", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: "Folder" }));
    await user.click(screen.getByRole("option", { name: "Staging" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(props.onSubmit).toHaveBeenCalledWith({ folder: "Staging" });
  });

  it("value starts empty (keep current) and typing a value sends it", async () => {
    const user = userEvent.setup();
    const props = setup();
    const value = screen.getByLabelText("Value");
    expect(value).toHaveValue("");
    await user.type(value, "new-secret");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(props.onSubmit).toHaveBeenCalledWith({ value: "new-secret" });
  });

  it("shows the current value on demand; leaving it untouched is not an edit", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: "Show current value" }));
    await waitFor(() => expect(screen.getByLabelText("Value")).toHaveValue("old-value"));
    expect(props.onLoadValue).toHaveBeenCalledTimes(1);
    // nothing changed => save disabled, and no prompt on close
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("editing a revealed value sends it", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: "Show current value" }));
    const value = await screen.findByDisplayValue("old-value");
    await user.type(value, "!");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(props.onSubmit).toHaveBeenCalledWith({ value: "old-value!" });
  });

  it("warns that renaming or moving breaks consumers", async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.queryByText(/will get a 404/)).toBeNull();
    await user.type(screen.getByLabelText("Key"), "X");
    expect(screen.getByText(/will get a 404/)).toBeInTheDocument();
  });

  it("shows a server error inline (e.g. 409 collision)", async () => {
    const user = userEvent.setup();
    setup({ onSubmit: vi.fn().mockResolvedValue("Secret 'B' already exists in folder 'Prod'") });
    await user.type(screen.getByLabelText("Key"), "X");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already exists/);
  });

  it("rejects an invalid key without calling the server", async () => {
    const user = userEvent.setup();
    const props = setup();
    const key = screen.getByLabelText("Key");
    await user.clear(key);
    await user.type(key, "1BAD");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("asks before discarding unsaved edits", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.type(screen.getByLabelText("Key"), "X");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Discard changes?")).toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});
