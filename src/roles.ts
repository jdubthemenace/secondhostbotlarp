import { db, nowMs } from "./db.js";
import { FOUNDER_ID, STARTING_CREDITS } from "./config.js";

export type Role =
  | "founder"
  | "cofounder"
  | "superadmin"
  | "admin"
  | "moderator"
  | "user"
  | "banned";

export const ROLE_RANK: Record<Role, number> = {
  banned: -1,
  user: 0,
  moderator: 1,
  admin: 2,
  superadmin: 3,
  cofounder: 4,
  founder: 5,
};

export const ROLE_LABEL: Record<Role, string> = {
  banned: "Banned",
  user: "User",
  moderator: "Moderator",
  admin: "Admin",
  superadmin: "Super Admin",
  cofounder: "Co-Founder",
  founder: "Founder",
};

export const VALID_ROLES: Role[] = [
  "user",
  "moderator",
  "admin",
  "superadmin",
  "cofounder",
];

export interface UserRow {
  user_id: number;
  username: string | null;
  first_name: string | null;
  role: Role;
  plan: "free" | "pro" | "vip";
  credits: number;
  banned: number;
  referrer_id: number | null;
  created_at: number;
  updated_at: number;
}

export function ensureUser(
  userId: number,
  username?: string | null,
  firstName?: string | null,
): UserRow {
  const existing = db
    .prepare("SELECT * FROM users WHERE user_id = ?")
    .get(userId) as UserRow | undefined;

  const ts = nowMs();
  if (!existing) {
    const role: Role = userId === FOUNDER_ID ? "founder" : "user";
    db.prepare(
      `INSERT INTO users(user_id, username, first_name, role, plan, credits, banned, created_at, updated_at)
       VALUES(?, ?, ?, ?, 'free', ?, 0, ?, ?)`,
    ).run(
      userId,
      username ?? null,
      firstName ?? null,
      role,
      STARTING_CREDITS,
      ts,
      ts,
    );
    return db
      .prepare("SELECT * FROM users WHERE user_id = ?")
      .get(userId) as UserRow;
  }

  if (
    (username ?? null) !== existing.username ||
    (firstName ?? null) !== existing.first_name
  ) {
    db.prepare(
      "UPDATE users SET username = ?, first_name = ?, updated_at = ? WHERE user_id = ?",
    ).run(username ?? null, firstName ?? null, ts, userId);
  }

  if (userId === FOUNDER_ID && existing.role !== "founder") {
    db.prepare(
      "UPDATE users SET role = 'founder', banned = 0, updated_at = ? WHERE user_id = ?",
    ).run(ts, userId);
  }

  return db
    .prepare("SELECT * FROM users WHERE user_id = ?")
    .get(userId) as UserRow;
}

export function getUser(userId: number): UserRow | undefined {
  return db
    .prepare("SELECT * FROM users WHERE user_id = ?")
    .get(userId) as UserRow | undefined;
}

export function setRole(userId: number, role: Role): boolean {
  if (userId === FOUNDER_ID) return false;
  db.prepare(
    "UPDATE users SET role = ?, updated_at = ? WHERE user_id = ?",
  ).run(role, nowMs(), userId);
  return true;
}

export function setBan(userId: number, banned: boolean): boolean {
  if (userId === FOUNDER_ID) return false;
  db.prepare(
    "UPDATE users SET banned = ?, updated_at = ? WHERE user_id = ?",
  ).run(banned ? 1 : 0, nowMs(), userId);
  return true;
}

export function setPlan(userId: number, plan: "free" | "pro" | "vip"): void {
  db.prepare(
    "UPDATE users SET plan = ?, updated_at = ? WHERE user_id = ?",
  ).run(plan, nowMs(), userId);
}

export function effectiveRole(user: UserRow): Role {
  if (user.user_id === FOUNDER_ID) return "founder";
  if (user.banned) return "banned";
  return user.role;
}

export function hasRoleAtLeast(user: UserRow, minimum: Role): boolean {
  const role = effectiveRole(user);
  if (role === "banned") return false;
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export function isFounder(userId: number): boolean {
  return userId === FOUNDER_ID;
}
