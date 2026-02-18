import Popup from "reactjs-popup";

export default function DeleteDialog({ open, onClose, target, onConfirm, busy }) {
  return (
    <Popup
      open={open}
      modal
      closeOnDocumentClick
      onClose={onClose}
      overlayStyle={{ background: "rgba(15, 23, 42, 0.4)", backdropFilter: "blur(4px)" }}
      contentStyle={{
        maxWidth: "460px",
        width: "90vw",
        borderRadius: "12px",
        border: "1px solid #fecaca",
        padding: 0,
        overflow: "hidden",
      }}
    >
      <div className="bg-white p-6">
        <h3 className="text-lg font-bold text-slate-900 mb-2">Delete this credential?</h3>
        <p className="text-slate-600 mb-6 p-3 bg-slate-50 rounded font-mono text-sm">
          {target || "Selected secret"}
        </p>
        <div className="flex gap-3">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-danger flex-1"
            onClick={onConfirm}
            disabled={busy}
          >
            Confirm Delete
          </button>
        </div>
      </div>
    </Popup>
  );
}
