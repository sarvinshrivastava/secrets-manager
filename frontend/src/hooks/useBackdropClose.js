import { useRef } from "react";

// Close a modal only when the press AND the release both land on the backdrop
// itself, so dragging a text selection out of the card never dismisses it.
export function useBackdropClose(onClose) {
  const downOnBackdrop = useRef(false);
  return {
    onMouseDown: (event) => {
      downOnBackdrop.current = event.target === event.currentTarget;
    },
    onClick: (event) => {
      const both = downOnBackdrop.current && event.target === event.currentTarget;
      downOnBackdrop.current = false;
      if (both) onClose();
    },
  };
}
