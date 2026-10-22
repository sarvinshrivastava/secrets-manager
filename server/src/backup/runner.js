// The in-process backup runner: one slot per day, retries, boot catch-up,
// local snapshot → off-site copy → retention → Kuma, and one audit row per
// attempt. Runs are serialised on one promise chain and never reject.
import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { BackupError, networkErrorTag, redact, toBackupError } from "./errors.js";
import {
  dueSlot,
  nextSlotStart,
  RETRY_DELAYS_MS,
  RUN_DEADLINE_MS,
} from "./schedule.js";
import {
  cleanInflight,
  ensureLocalSnapshot,
  listLocal,
  MAX_OFFSITE_DB_BYTES,
} from "./snapshot.js";
import {
  classifyAsset,
  LABEL_RE,
  selectLocalDeletions,
  selectRemoteDeletions,
} from "./retention.js";
import {
  createGithubClient,
  discardBody,
  encryptSnapshot,
  verifyAsset,
} from "./offsite.js";

export const CATCHUP_DELAY_MS = 120_000;
export const KUMA_RETRY_OFFSETS_MS = [60_000, 300_000, 900_000];
const KUMA_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 1 + RETRY_DELAYS_MS.length;
const TOKEN_EXPIRY_WARN_MS = 7 * 24 * 60 * 60 * 1000;
const AUDIT_TOKEN_NAME = "system:backup"; // ':' is impossible in a real token name

export { redact };

// The push URL is a capability: it is never logged, only the HTTP status or
// the network error code is.
export async function pushKuma(url, status, code, fetchImpl, log, signal) {
  try {
    const u = new URL(url);
    u.searchParams.set("status", status);
    u.searchParams.set("msg", code);
    u.searchParams.set("ping", "");
    const res = await fetchImpl(u.toString(), {
      method: "GET",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(KUMA_TIMEOUT_MS)])
        : AbortSignal.timeout(KUMA_TIMEOUT_MS),
    });
    await discardBody(res);
    if (!res.ok) {
      log.error(`backup: kuma push failed: ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    log.error(`backup: kuma push failed: ${networkErrorTag(err)}`);
    return false;
  }
}

export function createBackupRunner({
  db,
  settings,
  now = () => new Date(),
  fetchImpl = fetch,
  log = console,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  snapshot = ensureLocalSnapshot,
  statfs,
}) {
  const cfg = settings.backup;
  const { dir, time, keepDays, offsite, pushUrl, localErrors, offsiteErrors } =
    cfg;
  const secrets = [offsite?.token, pushUrl];
  const pushPath = pushUrl ? new URL(pushUrl).pathname : "";
  if (pushPath.length > 1) secrets.push(pushPath); // never redact a bare "/"
  const say = (level, msg) => log[level](redact(msg, secrets));

  let closed = false;
  let chain = Promise.resolve();
  const pending = new Map(); // slot → promise of the running or queued run
  const attempts = new Map(); // slot → attempts started
  let currentRun = null;
  let slotTimer = null;
  let catchupTimer = null;
  const retryTimers = new Map(); // slot → pending retry timer (one per slot)
  let kumaTimer = null;
  let kumaResend = null; // AbortController of an in-flight "up" re-send

  const arm = (fn, ms) => {
    const t = setTimer(() => {
      Promise.resolve()
        .then(fn)
        .catch((err) => say("error", `backup: timer error: ${err?.name ?? "error"}`));
    }, Math.max(0, ms));
    t?.unref?.();
    return t;
  };
  const sleep = (ms) =>
    new Promise((resolve) => {
      const t = setTimer(resolve, ms);
      t?.unref?.();
    });

  function abandon(run) {
    run.abandoned = true;
    run.controller.abort();
  }

  // ── one attempt ─────────────────────────────────────────────────────────
  async function runSlot(slot, run, ctx) {
    const guard = () => {
      if (run.abandoned || closed) throw new BackupError("timeout");
    };
    const { signal } = run.controller;

    ctx.stage = "local";
    const snap = await snapshot(db, {
      dir,
      slot,
      dbPath: settings.dbPath,
      statfs,
      guard,
    });
    guard();
    ctx.reused = snap.reused;
    ctx.plain_bytes = snap.bytes;
    ctx.secrets = snap.counts.secrets;
    ctx.tokens = snap.counts.tokens;
    ctx.notes.push(...(snap.notes ?? []));

    try {
      const doomed = selectLocalDeletions(listLocal(dir), {
        currentSlot: slot,
        keepDays,
      });
      for (const name of doomed) {
        guard();
        fs.unlinkSync(path.join(dir, name));
      }
    } catch (err) {
      if (err?.code === "timeout") throw err;
      ctx.notes.push("local_rotation_failed");
    }

    if (offsiteErrors.length > 0) throw new BackupError(offsiteErrors[0]);
    if (!offsite) {
      ctx.stage = "local_only";
      // A mistyped local key fell back to its default: report it on every run.
      if (localErrors.length > 0) throw new BackupError("config_invalid");
      return { kuma: null };
    }
    // The off-site copy is buffered in memory: refuse it before it can OOM
    // the vault (the local copy above is kept).
    if (snap.bytes > MAX_OFFSITE_DB_BYTES) {
      ctx.stage = "offsite";
      throw new BackupError("db_too_large");
    }

    ctx.stage = "offsite";
    ctx.reconciled = false;
    const client = createGithubClient({ ...offsite, fetchImpl, log, signal });
    const name = `secrets-${slot}.db.gz.age`;
    const release = await client.getRelease();

    // true = the slot already has a verified copy. A good-looking asset is
    // deleted only on a definite mismatch; any other error fails the attempt
    // and leaves it alone.
    async function reconcile() {
      const asset = (await client.listAssets(release.id)).find(
        (a) => a.name === name,
      );
      if (!asset) return false;
      const kind = classifyAsset(asset);
      if (kind === "foreign") throw new BackupError("slot_asset_foreign");
      if (kind === "good") {
        try {
          await verifyAsset(client, asset, LABEL_RE.exec(asset.label)[1], {
            sleep,
          });
          return true;
        } catch (err) {
          if (err?.code !== "verify_mismatch") throw err;
        }
      }
      guard();
      await client.deleteAsset(asset.id);
      return false;
    }

    let enc = null;
    for (let pass = 0; pass < 2; pass += 1) {
      guard();
      if (await reconcile()) {
        ctx.reconciled = true;
        break;
      }
      guard();
      if (!enc) {
        try {
          enc = await encryptSnapshot(snap.file, offsite.recipients, { signal });
        } catch (err) {
          throw signal.aborted
            ? new BackupError("timeout", { cause: err })
            : toBackupError(err, "local"); // fs errors → local_failed
        }
      }
      ctx.gz_bytes = enc.gzBytes;
      ctx.cipher_bytes = enc.bytes.length;
      guard();
      let asset;
      try {
        asset = await client.uploadAsset(release.id, name, enc.bytes, enc.sha256);
      } catch (err) {
        if (err?.status === 422 && pass === 0) continue; // already exists: reconcile once
        throw err;
      }
      try {
        await verifyAsset(client, asset, enc.sha256, {
          expectedSize: enc.bytes.length,
          sleep,
        });
      } catch (err) {
        // Our own upload is definitely wrong: remove it now (best effort) so
        // it cannot be counted as a good copy later.
        if (err?.code === "verify_mismatch" && !run.abandoned && !closed) {
          await client.deleteAsset(asset.id).catch((e) => {
            say("warn", `backup: cleanup of a mismatched upload failed: ${e?.code ?? e?.name ?? "error"}`);
          });
        }
        throw err;
      }
      break;
    }

    // Retention runs only once the current slot is verified. Its failure is a
    // note: the next slot repeats it.
    ctx.stage = "retention";
    try {
      guard();
      const doomed = selectRemoteDeletions(await client.listAssets(release.id), {
        currentSlot: slot,
        keepDaily: offsite.keepDaily,
        keepMonthly: offsite.keepMonthly,
      });
      for (const id of doomed) {
        guard();
        await client.deleteAsset(id);
      }
    } catch (err) {
      if (err?.code === "timeout") throw err;
      ctx.notes.push("retention_failed");
    }

    ctx.stage = "done";
    // Off-site copy exists, but a local key was mistyped: page so it is fixed.
    if (localErrors.length > 0) throw new BackupError("config_invalid");
    const expires = client.tokenExpiresAt;
    if (expires && expires.getTime() - now().getTime() < TOKEN_EXPIRY_WARN_MS) {
      ctx.code = "token_expiring";
      return { kuma: ["down", "token_expiring"] };
    }
    return { kuma: ["up", "OK"] };
  }

  // ── bookkeeping around an attempt ───────────────────────────────────────
  function audit(slot, status, ctx) {
    if (closed) return;
    try {
      db.insertAuditLog({
        tokenName: AUDIT_TOKEN_NAME,
        action: "backup",
        keyName: slot,
        status,
        ipAddress: null,
        details: JSON.stringify(ctx),
      });
    } catch (err) {
      say("error", `backup: audit write failed: ${err?.name ?? "error"}`);
    }
  }

  // Cancels a pending "up" re-send AND aborts one already in flight, so a
  // stale "up" can neither land after a newer push nor re-arm its chain.
  function cancelKumaRetry() {
    if (kumaTimer) clearTimer(kumaTimer);
    kumaTimer = null;
    kumaResend?.abort();
    kumaResend = null;
  }

  function scheduleKumaRetry(index = 0) {
    if (kumaTimer) clearTimer(kumaTimer);
    const prev = index === 0 ? 0 : KUMA_RETRY_OFFSETS_MS[index - 1];
    kumaTimer = arm(async () => {
      kumaTimer = null;
      if (closed) return;
      const resend = new AbortController();
      kumaResend = resend;
      const ok = await pushKuma(pushUrl, "up", "OK", fetchImpl, log, resend.signal);
      if (kumaResend !== resend || closed) return; // superseded or stopped
      kumaResend = null;
      if (!ok && index + 1 < KUMA_RETRY_OFFSETS_MS.length) {
        scheduleKumaRetry(index + 1);
      }
    }, KUMA_RETRY_OFFSETS_MS[index] - prev);
  }

  function clearRetry(slot) {
    const t = retryTimers.get(slot);
    if (t) clearTimer(t);
    retryTimers.delete(slot);
  }

  function scheduleRetry(slot, attempt) {
    const prev = retryTimers.get(slot);
    if (prev) clearTimer(prev);
    retryTimers.set(
      slot,
      arm(() => {
        retryTimers.delete(slot);
        return trigger(slot, "retry");
      }, RETRY_DELAYS_MS[attempt - 1]),
    );
  }

  async function execute(slot, kind) {
    if (closed) return { slot, status: "skipped" };
    const attempt = (attempts.get(slot) ?? 0) + 1;
    attempts.set(slot, attempt);
    const run = { controller: new AbortController(), abandoned: false };
    currentRun = run;
    const startedAt = now().getTime();
    const loop = monitorEventLoopDelay({ resolution: 20 });
    loop.enable();
    const ctx = {
      trigger: kind,
      attempt,
      stage: "start",
      code: null,
      notes: [],
      reused: null,
      reconciled: null,
      plain_bytes: null,
      gz_bytes: null,
      cipher_bytes: null,
      secrets: null,
      tokens: null,
      duration_ms: null,
      max_loop_delay_ms: null,
    };

    let deadlineTimer;
    const deadline = new Promise((_, reject) => {
      deadlineTimer = setTimer(() => {
        abandon(run);
        reject(new BackupError("timeout"));
      }, RUN_DEADLINE_MS);
      deadlineTimer?.unref?.();
    });

    let outcome = null;
    let error = null;
    try {
      outcome = await Promise.race([runSlot(slot, run, ctx), deadline]);
    } catch (err) {
      error = toBackupError(err, "run");
      if (error.code === "internal") {
        say("error", `backup: internal error: ${err?.name ?? "error"}`);
      }
    } finally {
      clearTimer(deadlineTimer);
      loop.disable();
      if (currentRun === run) currentRun = null;
    }
    ctx.duration_ms = now().getTime() - startedAt;
    ctx.max_loop_delay_ms = Math.round(loop.max / 1e6);
    if (closed) return { slot, status: "skipped" };

    if (!error) {
      attempts.delete(slot);
      clearRetry(slot);
      if (outcome.kuma && pushUrl) {
        const [status, msg] = outcome.kuma;
        cancelKumaRetry(); // a newer push supersedes a pending "up" re-send
        const ok = await pushKuma(pushUrl, status, msg, fetchImpl, log);
        if (!ok && status === "up") {
          ctx.notes.push("kuma_failed");
          scheduleKumaRetry();
        }
      }
      audit(slot, "success", ctx);
      say(
        "info",
        `backup ${slot} ${kind} attempt=${attempt} success stage=${ctx.stage}` +
          `${ctx.code ? ` code=${ctx.code}` : ""}` +
          `${ctx.notes.length ? ` notes=${ctx.notes.join(",")}` : ""}`,
      );
      return { slot, status: "success", code: ctx.code, details: ctx };
    }

    ctx.code = error.code;
    const final = !error.retryable || attempt >= MAX_ATTEMPTS;
    if (final) {
      attempts.delete(slot);
      clearRetry(slot);
      if (pushUrl) {
        cancelKumaRetry(); // a stale "up" re-send must not hide this page
        await pushKuma(pushUrl, "down", error.code, fetchImpl, log);
      }
    } else {
      scheduleRetry(slot, attempt);
    }
    audit(slot, "error", ctx);
    say(
      "error",
      `backup ${slot} ${kind} attempt=${attempt} failed code=${error.code} ` +
        `stage=${ctx.stage}${final ? " final" : " retrying"}`,
    );
    return { slot, status: "error", code: error.code, final, details: ctx };
  }

  // Same slot running or queued → that promise. Another slot → queued after.
  function trigger(slot, kind) {
    if (closed) return Promise.resolve({ slot, status: "skipped" });
    if (pending.has(slot)) return pending.get(slot);
    const p = chain
      .then(() => execute(slot, kind))
      .catch((err) => {
        say("error", `backup: runner error: ${err?.name ?? "error"}`);
        return { slot, status: "error", code: "internal" };
      });
    pending.set(slot, p);
    chain = p;
    p.then(() => {
      if (pending.get(slot) === p) pending.delete(slot);
    });
    return p;
  }

  // ── timers ──────────────────────────────────────────────────────────────
  function armSlotTimer() {
    if (closed) return;
    const target = nextSlotStart(now(), time);
    slotTimer = arm(() => {
      if (closed) return undefined;
      if (now() < target) {
        armSlotTimer(); // early fire (clock moved back): re-arm, no run
        return undefined;
      }
      armSlotTimer(); // re-arm first: a stuck run cannot stop the schedule
      return trigger(dueSlot(now(), time), "scheduled");
    }, target.getTime() - now().getTime());
  }

  function catchup() {
    if (closed) return undefined;
    const slot = dueSlot(now(), time);
    const trueLocalOnly =
      !offsite &&
      offsiteErrors.length === 0 &&
      localErrors.length === 0;
    if (trueLocalOnly && fs.existsSync(path.join(dir, `secrets-${slot}.db`))) {
      return undefined;
    }
    return trigger(slot, "catchup");
  }

  const api = {
    start() {
      try {
        cleanInflight(dir);
      } catch (err) {
        say("warn", `backup: inflight cleanup failed: ${err?.code ?? err?.name}`);
      }
      if (cfg.offsiteDisabledReason) {
        say("info", `backup off-site disabled: ${cfg.offsiteDisabledReason}`);
      }
      for (const code of [...localErrors, ...offsiteErrors]) {
        say("error", `backup config error: ${code}`);
      }
      armSlotTimer();
      catchupTimer = arm(catchup, CATCHUP_DELAY_MS);
      return api;
    },
    stop() {
      closed = true;
      kumaResend?.abort();
      for (const t of [slotTimer, catchupTimer, kumaTimer, ...retryTimers.values()]) {
        if (t) clearTimer(t);
      }
      retryTimers.clear();
      slotTimer = catchupTimer = kumaTimer = null;
      if (currentRun) abandon(currentRun);
    },
    trigger,
    idle() {
      return chain.then(() => {});
    },
  };
  return api;
}
