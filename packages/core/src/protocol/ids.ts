import { monotonicFactory } from "ulidx"

const ulid = monotonicFactory()

export type IdPrefix = "msg" | "ses" | "blk" | "call" | "evt" | "run" | "conf" | "mem" | "cron" | "att" | "q" | "tm" | "tma"

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`
}
