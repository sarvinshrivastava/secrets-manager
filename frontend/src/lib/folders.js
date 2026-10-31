// Mirrors the server's folder-name rule (letters, digits, space, _ . -, 1-128
// chars) and additionally refuses dot-only names ("." ".."), which can never
// be addressed in a URL path.
export const FOLDER_NAME_RE = /^[A-Za-z0-9 _.-]{1,128}$/;

export function isValidFolderName(name) {
  return (
    typeof name === "string" &&
    FOLDER_NAME_RE.test(name) &&
    name.replace(/\./g, "") !== ""
  );
}

export const FOLDER_RULE_HINT =
  "Folder: 1-128 chars — letters, numbers, space, _ . -";
