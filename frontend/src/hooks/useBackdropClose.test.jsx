import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useBackdropClose } from "./useBackdropClose.js";

function Harness({ onClose }) {
  const backdrop = useBackdropClose(onClose);
  return (
    <div data-testid="backdrop" {...backdrop}>
      <div data-testid="card">card</div>
    </div>
  );
}

describe("useBackdropClose", () => {
  it("closes when mousedown and click both land on the backdrop", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const bd = screen.getByTestId("backdrop");
    fireEvent.mouseDown(bd);
    fireEvent.click(bd);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when the press started inside the card", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.mouseDown(screen.getByTestId("card"));
    fireEvent.click(screen.getByTestId("backdrop"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not close on a click inside the card", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const card = screen.getByTestId("card");
    fireEvent.mouseDown(card);
    fireEvent.click(card);
    expect(onClose).not.toHaveBeenCalled();
  });
});
