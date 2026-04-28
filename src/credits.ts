import { db, nowMs } from "./db.js";
import { ensureUser } from "./roles.js";
import { writeLog } from "./logs.js";

export class InsufficientCreditsError extends Error {
  constructor(public readonly available: number) {
    super("insufficient credits");
  }
}

export function getBalance(userId: number): number {
  const row = db
    .prepare("SELECT credits FROM users WHERE user_id = ?")
    .get(userId) as { credits: number } | undefined;
  return row?.credits ?? 0;
}

/** Atomic credit deduction. Throws InsufficientCreditsError if balance is too low. */
export function deductCredit(
  userId: number,
  cost: number,
  reason: string,
): number {
  if (cost <= 0) throw new Error("cost must be positive");
  const tx = db.transaction(() => {
    const row = db
      .prepare("SELECT credits FROM users WHERE user_id = ?")
      .get<{ credits: number }>(userId);
    if (!row) throw new InsufficientCreditsError(0);
    if (row.credits < cost) throw new InsufficientCreditsError(row.credits);
    db.prepare(
      "UPDATE users SET credits = credits - ?, updated_at = ? WHERE user_id = ? AND credits >= ?",
    ).run(cost, nowMs(), userId, cost);
    const after = db
      .prepare("SELECT credits FROM users WHERE user_id = ?")
      .get<{ credits: number }>(userId)!;
    return after.credits;
  });
  const remaining = tx();
  writeLog({
    type: "credit",
    userId,
    action: "deduct",
    meta: { amount: cost, remaining, reason },
  });
  return remaining;
}

export function refundCredit(
  userId: number,
  amount: number,
  reason: string,
): void {
  if (amount <= 0) return;
  db.prepare(
    "UPDATE users SET credits = credits + ?, updated_at = ? WHERE user_id = ?",
  ).run(amount, nowMs(), userId);
  writeLog({
    type: "credit",
    userId,
    action: "refund",
    meta: { amount, reason },
  });
}

export function setCredits(userId: number, value: number): void {
  ensureUser(userId);
  const v = Math.max(0, Math.floor(value));
  db.prepare(
    "UPDATE users SET credits = ?, updated_at = ? WHERE user_id = ?",
  ).run(v, nowMs(), userId);
  writeLog({
    type: "credit",
    userId,
    action: "set",
    meta: { value: v },
  });
}

export function addCredits(userId: number, amount: number): number {
  ensureUser(userId);
  const a = Math.max(0, Math.floor(amount));
  db.prepare(
    "UPDATE users SET credits = credits + ?, updated_at = ? WHERE user_id = ?",
  ).run(a, nowMs(), userId);
  writeLog({
    type: "credit",
    userId,
    action: "add",
    meta: { amount: a },
  });
  return getBalance(userId);
}

export function takeCredits(userId: number, amount: number): number {
  ensureUser(userId);
  const a = Math.max(0, Math.floor(amount));
  const tx = db.transaction(() => {
    const row = db
      .prepare("SELECT credits FROM users WHERE user_id = ?")
      .get<{ credits: number }>(userId);
    if (!row) return 0;
    const take = Math.min(row.credits, a);
    db.prepare(
      "UPDATE users SET credits = credits - ?, updated_at = ? WHERE user_id = ?",
    ).run(take, nowMs(), userId);
    return take;
  });
  const taken = tx();
  writeLog({
    type: "credit",
    userId,
    action: "take",
    meta: { amount: taken },
  });
  return getBalance(userId);
}
