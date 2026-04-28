import { getSetting, setSetting } from "./db.js";
import { DEFAULT_RATE_LIMIT_PER_MIN } from "./config.js";

export interface BotState {
  maintenance: boolean;
  locked: boolean;
  panic: boolean;
  debug: boolean;
  rateLimitPerMin: number;
}

const KEY = (k: string) => `state:${k}`;

function readBool(key: string, fallback = false): boolean {
  const v = getSetting(KEY(key));
  if (v == null) return fallback;
  return v === "1";
}

function writeBool(key: string, value: boolean): void {
  setSetting(KEY(key), value ? "1" : "0");
}

export const state: BotState = {
  maintenance: readBool("maintenance"),
  locked: readBool("locked"),
  panic: readBool("panic"),
  debug: readBool("debug"),
  rateLimitPerMin: Number(
    getSetting(KEY("rateLimit")) ?? String(DEFAULT_RATE_LIMIT_PER_MIN),
  ),
};

export function setMaintenance(v: boolean) {
  state.maintenance = v;
  writeBool("maintenance", v);
}
export function setLocked(v: boolean) {
  state.locked = v;
  writeBool("locked", v);
}
export function setPanic(v: boolean) {
  state.panic = v;
  writeBool("panic", v);
}
export function setDebug(v: boolean) {
  state.debug = v;
  writeBool("debug", v);
}
export function setRateLimit(perMin: number) {
  state.rateLimitPerMin = Math.max(1, Math.floor(perMin));
  setSetting(KEY("rateLimit"), String(state.rateLimitPerMin));
}
