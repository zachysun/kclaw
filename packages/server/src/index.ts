export const SERVER_NAME = "@kclaw/server"

export * from "./auth.js"
export * from "./app.js"
// bus.ts / confirm.ts moved into core (card ①); keep the server public surface identical.
export { EventBus, type BusSocket, ConfirmationBroker, type ConfirmationResolution, type ConfirmationActor } from "@kclaw/core"
export * from "./daemon.js"
export * from "./run.js"
export * from "./scheduler-tick.js"
export * from "./ws.js"
export * from "./routes/sessions.js"
export * from "./routes/jobs.js"
export * from "./routes/config.js"
