import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ConfirmDialog from "./ConfirmDialog.jsx";

function setup(props = {}) {
  const onClose = vi.fn();
  const onConfirm = vi.fn();
  render(
    <ConfirmDialog
      open
      title="Delete?"
      danger
      onClose={onClose}
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return { onClose, onConfirm };
}

describe("ConfirmDialog", () => {
  it("focuses Cancel on open when danger", () => {
    setup();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("closes on Escape and on a full backdrop click", () => {
    const { onClose } = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    const backdrop = screen.getByRole("dialog").parentElement;
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("ignores a click whose press started inside the card", () => {
    const { onClose } = setup();
    const dialog = screen.getByRole("dialog");
    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog.parentElement);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores Escape and the backdrop while busy", () => {
    const { onClose } = setup({ busy: true });
    fireEvent.keyDown(window, { key: "Escape" });
    const backdrop = screen.getByRole("dialog").parentElement;
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });
});
