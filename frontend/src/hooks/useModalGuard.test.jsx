import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useModalGuard, __resetModalGuardForTests } from "./useModalGuard.jsx";

function Harness({ initialOpen = true, dirty = false, onClosed = () => {} }) {
  const [open, setOpen] = useState(initialOpen);
  const { requestClose, discardDialog } = useModalGuard({
    open,
    dirty,
    onClose: () => {
      onClosed();
      setOpen(false);
    },
  });
  return (
    <div>
      <button onClick={() => setOpen(true)}>open</button>
      {open && (
        <div role="dialog">
          dialog
          <button onClick={requestClose}>close</button>
        </div>
      )}
      {discardDialog}
    </div>
  );
}

// jsdom's history.back() is async; model the browser Back button by popping our
// entry synchronously and firing popstate with the previous state.
let pushSpy;
let backSpy;
function pressBack(previousState = null) {
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate", { state: previousState }));
  });
}

beforeEach(() => {
  __resetModalGuardForTests();
  pushSpy = vi.spyOn(window.history, "pushState");
  backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("useModalGuard", () => {
  it("pushes exactly one history entry when it opens", () => {
    render(<Harness initialOpen />);
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it("Back on a clean dialog closes it and does not call history.back()", () => {
    render(<Harness />);
    pressBack();
    expect(screen.queryByText("dialog")).toBeNull();
    expect(backSpy).not.toHaveBeenCalled();
  });

  it("Back on a dirty dialog re-pushes and asks before discarding", () => {
    const onClosed = vi.fn();
    render(<Harness dirty onClosed={onClosed} />);
    pressBack();
    expect(pushSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Discard changes?")).toBeInTheDocument();
    expect(screen.getByText("dialog")).toBeInTheDocument();
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("Keep editing leaves the dialog open", () => {
    render(<Harness dirty />);
    pressBack();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Discard changes?")).toBeNull();
    expect(screen.getByText("dialog")).toBeInTheDocument();
  });

  it("Discard closes the dialog and pops our entry once", () => {
    render(<Harness dirty />);
    pressBack();
    // our re-pushed entry is the current state
    const state = pushSpy.mock.calls.at(-1)[0];
    vi.spyOn(window.history, "state", "get").mockReturnValue(state);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByText("dialog")).toBeNull();
    expect(backSpy).toHaveBeenCalledTimes(1);
  });

  it("closing from the X pops our entry once (clean)", () => {
    render(<Harness />);
    const state = pushSpy.mock.calls.at(-1)[0];
    vi.spyOn(window.history, "state", "get").mockReturnValue(state);
    fireEvent.click(screen.getByRole("button", { name: "close" }));
    expect(screen.queryByText("dialog")).toBeNull();
    expect(backSpy).toHaveBeenCalledTimes(1);
  });

  it("a dirty X asks first instead of closing", () => {
    render(<Harness dirty />);
    fireEvent.click(screen.getByRole("button", { name: "close" }));
    expect(screen.getByText("Discard changes?")).toBeInTheDocument();
    expect(screen.getByText("dialog")).toBeInTheDocument();
  });

  it("Escape with the confirm open only dismisses the confirm", () => {
    render(<Harness dirty />);
    fireEvent.click(screen.getByRole("button", { name: "close" }));
    expect(screen.getByText("Discard changes?")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Discard changes?")).toBeNull();
    expect(screen.getByText("dialog")).toBeInTheDocument();
  });

  it("a re-render while open never touches history", () => {
    const { rerender } = render(<Harness dirty={false} />);
    rerender(<Harness dirty />);
    rerender(<Harness dirty={false} />);
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(backSpy).not.toHaveBeenCalled();
  });

  it("unmounting while open (forced logout) pops our entry once", () => {
    const { unmount } = render(<Harness />);
    const state = pushSpy.mock.calls.at(-1)[0];
    vi.spyOn(window.history, "state", "get").mockReturnValue(state);
    unmount();
    expect(backSpy).toHaveBeenCalledTimes(1);
  });

  it("does not call history.back() if our entry is no longer current", () => {
    const { unmount } = render(<Harness />);
    vi.spyOn(window.history, "state", "get").mockReturnValue(null);
    unmount();
    expect(backSpy).not.toHaveBeenCalled();
  });
});
