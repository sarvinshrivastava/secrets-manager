import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Listbox } from "@headlessui/react";
import { MdArrowDropDown, MdCheck, MdClose } from "react-icons/md";
import { isValidFolderName, FOLDER_RULE_HINT } from "../lib/folders.js";

const NEW_FOLDER = "\u0000new-folder"; // can never collide with a valid name

// Dropdown folder picker. "+ New folder…" swaps the whole control for a plain
// text input (kept OUTSIDE Listbox.Options so typing a space does not trigger
// the listbox's select-on-space). While typing, the draft is reported live via
// onChange so submitting never silently uses a stale folder; the parent
// validates on submit with isValidFolderName.
export default function FolderSelect({
  value,
  onChange,
  folders,
  id,
  label = "Folder",
  dropUp = false,
  allowNew = true,
  startInNew = false,
  className = "",
}) {
  const [mode, setMode] = useState(startInNew ? "new" : "select");
  const [previous, setPrevious] = useState(value);
  const buttonRef = useRef(null);
  const refocus = useRef(false);
  const hintId = useId();

  // Leaving the name input unmounts it; hand focus to the select button so it
  // never falls back to <body>.
  useEffect(() => {
    if (mode === "select" && refocus.current) {
      refocus.current = false;
      buttonRef.current?.focus();
    }
  }, [mode]);

  function backToSelect() {
    refocus.current = true;
    setMode("select");
  }

  // Options are the folders as given (scoped tokens never see Root unless it is
  // theirs) plus the current value so the button never shows a blank.
  const options = useMemo(
    () => [...new Set([...folders, value].filter(Boolean))],
    [folders, value],
  );

  if (mode === "new") {
    const trimmed = (value || "").trim();
    const invalid = trimmed !== "" && !isValidFolderName(trimmed);
    function finish() {
      if (trimmed !== "" && !invalid) backToSelect();
    }
    return (
      <div className={className}>
        <div className="flex gap-1">
          <input
            id={id}
            autoFocus
            aria-label={`New ${label.toLowerCase()} name`}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? hintId : undefined}
            value={value}
            placeholder="new-folder-name"
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                finish();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onChange(previous);
                backToSelect();
              }
            }}
            className="sm-input"
          />
          <button
            type="button"
            className="sm-btn px-2"
            aria-label="Cancel new folder"
            title="Back to folder list"
            onClick={() => {
              onChange(previous);
              backToSelect();
            }}
          >
            <MdClose size={16} />
          </button>
        </div>
        {invalid && (
          <p
            id={hintId}
            role="alert"
            className="mt-1 font-mono text-xs text-danger"
          >
            {FOLDER_RULE_HINT}
          </p>
        )}
      </div>
    );
  }

  return (
    <Listbox
      value={value}
      onChange={(next) => {
        if (next === NEW_FOLDER) {
          setPrevious(value);
          onChange("");
          setMode("new");
        } else {
          onChange(next);
        }
      }}
    >
      <div className={`relative ${className}`}>
        <Listbox.Button
          ref={buttonRef}
          id={id}
          aria-label={label}
          className="sm-input flex items-center justify-between gap-2 text-left"
        >
          <span className="min-w-0 flex-1 truncate" title={value}>
            {value || "Select folder"}
          </span>
          <MdArrowDropDown size={18} className="flex-none text-faint" />
        </Listbox.Button>
        <Listbox.Options
          className={`absolute z-50 max-h-60 w-full overflow-y-auto border border-line-strong bg-surface py-1 shadow-lg focus:outline-none ${
            dropUp ? "bottom-full mb-1" : "mt-1"
          }`}
        >
          {options.map((name) => (
            <Listbox.Option
              key={name}
              value={name}
              className={({ active }) =>
                `flex cursor-pointer items-center gap-2 px-3 py-1.5 font-mono text-sm text-ink ${
                  active ? "bg-accent-soft" : ""
                }`
              }
            >
              {({ selected }) => (
                <>
                  <span className="min-w-0 flex-1 truncate" title={name}>
                    {name}
                  </span>
                  {selected && (
                    <MdCheck size={14} className="flex-none text-accent" />
                  )}
                </>
              )}
            </Listbox.Option>
          ))}
          {allowNew && (
            <Listbox.Option
              value={NEW_FOLDER}
              className={({ active }) =>
                `cursor-pointer border-t border-line px-3 py-1.5 font-mono text-sm text-accent ${
                  active ? "bg-accent-soft" : ""
                }`
              }
            >
              + New folder…
            </Listbox.Option>
          )}
        </Listbox.Options>
      </div>
    </Listbox>
  );
}
