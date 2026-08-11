import { Router } from "express";
import { isValidFolderName, scopeAllowsFolder } from "../utils.js";

const RESERVED_FOLDER = "Root";

export function createFoldersRouter(
  db,
  { requireAuth, requireWriteAccess, writeAudit },
) {
  const router = Router();

  // GET /api/folders — read token. Distinct folders in use, unioned with the
  // reserved Root, filtered to the token's scope.
  router.get("/", requireAuth, (req, res) => {
    const set = new Set([RESERVED_FOLDER, ...db.listFolders()]);
    const folders = [...set]
      .filter((f) => scopeAllowsFolder(req.auth.scope, f))
      .sort((a, b) => a.localeCompare(b));
    res.json({ folders });
  });

  router.post("/rename", requireAuth, requireWriteAccess, (req, res) => {
    const { from, to } = req.body || {};

    if (typeof from !== "string" || !from.trim()) {
      return res.status(400).json({ detail: "Source folder is required" });
    }
    if (typeof to !== "string" || !to.trim()) {
      return res.status(400).json({ detail: "Target folder is required" });
    }

    const source = from.trim();
    const target = to.trim();

    if (source === target) {
      return res
        .status(400)
        .json({ detail: "Source and target folders must differ" });
    }

    if (!isValidFolderName(source) || !isValidFolderName(target)) {
      return res.status(400).json({ detail: "Invalid folder name" });
    }

    // Root is hardcoded in the deploy template — never rename it away or onto it.
    if (source === RESERVED_FOLDER || target === RESERVED_FOLDER) {
      return res
        .status(409)
        .json({ detail: `Folder '${RESERVED_FOLDER}' is reserved` });
    }

    // A key present in BOTH folders would violate UNIQUE(folder, key) and the
    // bulk UPDATE would throw SQLITE_CONSTRAINT (→ 500). Detect and 409 first.
    const collisions = db.folderKeyCollisions(source, target);
    if (collisions.length > 0) {
      return res.status(409).json({
        detail: `Cannot rename: key(s) already exist in '${target}': ${collisions.join(", ")}`,
      });
    }

    let renamed;
    try {
      renamed = db.renameFolder(source, target);
    } catch (err) {
      if (
        err.code === "SQLITE_CONSTRAINT_UNIQUE" ||
        err.code === "SQLITE_CONSTRAINT"
      ) {
        return res.status(409).json({
          detail: `Cannot rename: a key already exists in '${target}'`,
        });
      }
      throw err;
    }

    writeAudit(req, {
      action: "folder_renamed",
      status: "ok",
      tokenName: req.auth.name,
      details: `${source} -> ${target} (${renamed} secrets)`,
    });

    return res.json({ status: "ok", from: source, to: target, renamed });
  });

  return router;
}
