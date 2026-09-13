import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/index.js"
import type { FastifyInstance } from "fastify"

describe("static shell exemption", () => {
  let home: string
  let dist: string
  let app: FastifyInstance

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kclaw-shell-test-"))
    dist = join(home, "dist")
    await mkdir(join(dist, "assets"), { recursive: true })
    await writeFile(join(dist, "index.html"), "<html>kclaw-web-shell</html>", "utf8")
    await writeFile(join(dist, "assets", "app.js"), "console.log('kclaw')", "utf8")
    app = await createApp({ home, token: "t1", webDist: dist })
  })

  afterEach(async () => {
    await app.close()
    await rm(home, { recursive: true, force: true })
  })

  it("GET / without a token serves the shell html", async () => {
    const res = await app.inject({ method: "GET", url: "/" })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain("kclaw-web-shell")
    expect(res.headers["content-type"]).toContain("text/html")
  })

  it("GET /index.html without a token serves the shell html", async () => {
    const res = await app.inject({ method: "GET", url: "/index.html" })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain("kclaw-web-shell")
  })

  it("GET /assets/app.js without a token serves the asset", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/app.js" })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain("console.log('kclaw')")
  })

  it("exempted shell paths stay exempt with a ?token= query string", async () => {
    const root = await app.inject({ method: "GET", url: "/?token=whatever" })
    expect(root.statusCode).toBe(200)
    const asset = await app.inject({ method: "GET", url: "/assets/app.js?token=whatever" })
    expect(asset.statusCode).toBe(200)
  })

  it("the favicon declared by index.html is exempt without a token", async () => {
    await writeFile(join(dist, "favicon.svg"), "<svg/>", "utf8")
    const res = await app.inject({ method: "GET", url: "/favicon.svg" })
    expect(res.statusCode).toBe(200)
  })

  it("other static-root files are NOT exempt", async () => {
    await writeFile(join(dist, "robots.txt"), "User-agent: *", "utf8")
    const res = await app.inject({ method: "GET", url: "/robots.txt" })
    expect(res.statusCode).toBe(401)
  })

  it("GET /sessions without a token is still 401", async () => {
    const res = await app.inject({ method: "GET", url: "/sessions" })
    expect(res.statusCode).toBe(401)
  })
})

describe("static shell exemption disabled without webDist", () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kclaw-noshell-test-"))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it("GET / without a token stays 401", async () => {
    const app = await createApp({ home, token: "t1" })
    try {
      const res = await app.inject({ method: "GET", url: "/" })
      expect(res.statusCode).toBe(401)
    } finally {
      await app.close()
    }
  })
})
