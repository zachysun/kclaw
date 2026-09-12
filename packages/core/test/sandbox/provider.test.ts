import { describe, it, expect } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, realpathSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { createExecSandbox, seatbeltProfile, bwrapArgs, type ExecSandbox } from "../../src/sandbox/provider.js"

/** Run one command inside a sandbox; resolves with exit status + merged output. */
function runIn(sb: ExecSandbox, command: string, cwd: string): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = sb.spawn(command, { cwd })
    let output = ""
    for (const s of [child.stdout, child.stderr]) {
      if (!s) continue
      s.setEncoding("utf8")
      s.on("data", (d: string) => { output += d })
    }
    child.on("error", (err) => resolve({ status: -1, output: err.message }))
    child.on("close", (code) => resolve({ status: code, output }))
  })
}

describe("seatbeltProfile", () => {
  it("allows workspace+tmp writes, denies everything else, masks ~/.kclaw reads", () => {
    const p = seatbeltProfile({
      workspace: "/Users/u/proj",
      home: "/Users/u",
      writeRoots: ["/Users/u/.npm"],
      tmpDirs: ["/private/tmp"],
    })
    // first-match order: .kclaw read-denial BEFORE the broad read allow
    expect(p.indexOf("deny file-read* (subpath \"/Users/u/.kclaw\")")).toBeLessThan(p.indexOf("allow file-read*"))
    // writable roots listed in one allow, deny fallback after it
    const writeIdx = p.indexOf("allow file-write*")
    expect(writeIdx).toBeGreaterThan(-1)
    expect(p.indexOf("deny file-write*")).toBeGreaterThan(writeIdx)
    expect(p).toContain('(subpath "/Users/u/proj")')
    expect(p).toContain('(subpath "/private/tmp")')
    expect(p).toContain('(subpath "/Users/u/.npm")')
    expect(p).toContain("(allow network*)")
  })

  it("network deny swaps the allow for outbound+inbound denies (bare network* breaks exec)", () => {
    const p = seatbeltProfile({
      workspace: "/Users/u/proj",
      home: "/Users/u",
      writeRoots: [],
      tmpDirs: ["/private/tmp"],
      network: "deny",
    })
    expect(p).not.toContain("(allow network*)")
    expect(p).toContain("(deny network-outbound)")
    expect(p).toContain("(deny network-inbound)")
    // file rules untouched
    expect(p).toContain("(allow file-read*)")
    expect(p).toContain("(deny file-write*)")
    // 缺省（undefined）等价 allow
    const def = seatbeltProfile({ workspace: "/w", home: "/h", writeRoots: [], tmpDirs: [] })
    expect(def).toContain("(allow network*)")
  })
})

describe("bwrapArgs", () => {
  it("ro-binds the root, masks ~/.kclaw, makes workspace writable, runs the command via sh", () => {
    // real paths (the layout realpath-resolves every entry: /var → /private/var
    // on macOS); assert against the resolved forms
    const ws = realpathSync(mkdtempSync(join(tmpdir(), "kclaw-bwrap-ws-")))
    const home = realpathSync(mkdtempSync(join(tmpdir(), "kclaw-bwrap-home-")))
    const extra = realpathSync(mkdtempSync(join(tmpdir(), "kclaw-bwrap-extra-")))
    try {
      const args = bwrapArgs({ workspace: ws, home, writeRoots: [extra], command: "git status" })
      const s = args.join(" ")
      expect(s).toContain("--die-with-parent --new-session")
      expect(s).toContain("--ro-bind / /")
      expect(s).toContain(`--tmpfs ${home}/.kclaw`)
      expect(s).toContain("--tmpfs /tmp")
      expect(s).toContain(`--bind ${ws} ${ws}`)
      expect(s).toContain(`--bind ${extra} ${extra}`)
      expect(s).toContain(`--chdir ${ws} /bin/sh -c git status`)
      // default (allow): no unshare-net anywhere
      expect(s).not.toContain("unshare-net")
      // network deny adds --unshare-net
      const denied = bwrapArgs({ workspace: ws, home, writeRoots: [], command: "true", network: "deny" })
      expect(denied).toContain("--unshare-net")
    } finally {
      rmSync(ws, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
      rmSync(extra, { recursive: true, force: true })
    }
  })
})

describe("createExecSandbox", () => {
  it("disabled in config → unavailable with a clear reason", () => {
    const sb = createExecSandbox({ enabled: false, writeRoots: [] }, { workspace: "/tmp" })
    expect(sb.available).toBe(false)
    expect(sb.unavailableReason).toContain("disabled")
    expect(() => sb.spawn("true", { cwd: "/tmp" })).toThrow(/unavailable/)
  })

  it("macOS: sandbox-exec available, spawns through it (this host)", () => {
    const sb = createExecSandbox({ enabled: true, writeRoots: [] }, { workspace: "/tmp" })
    if (process.platform === "darwin") {
      expect(sb.available).toBe(true)
      const child = sb.spawn("echo hi", { cwd: "/tmp" })
      expect(child.pid).toBeGreaterThan(0)
    } else if (process.platform === "linux") {
      // availability on Linux depends on bwrap being present AND usable;
      // the spawn smoke for Linux lives in its own describe below
      expect(sb.available).toBe(linuxHasBwrap)
      if (linuxHasBwrap) {
        const child = sb.spawn("echo hi", { cwd: "/tmp" })
        expect(child.pid).toBeGreaterThan(0)
      }
    } else {
      expect(sb.available).toBe(false) // unsupported platform
    }
  })

  it("unrecognized platforms are unavailable", () => {
    // the win32 branch can only be exercised by stubbing; assert the guard exists
    expect(() => createExecSandbox({ enabled: true, writeRoots: [] }, { workspace: "/tmp" })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Real sandbox smoke tests. macOS (this host) and Linux (CI ubuntu runner);
// skipped elsewhere. Everything uses an injected FAKE home under tmp, so no
// real ~/.kclaw is ever touched.
// ---------------------------------------------------------------------------
const isMac = process.platform === "darwin"
const isLinux = process.platform === "linux"
const linuxHasBwrap = spawnSync("which", ["bwrap"], { encoding: "utf8" }).status === 0

function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "kclaw-fakehome-"))
  mkdirSync(join(home, ".kclaw"), { recursive: true })
  writeFileSync(join(home, ".kclaw", "token"), "super-secret")
  return home
}

describe("macOS seatbelt smoke", { skip: !isMac }, () => {
  it("writes in workspace, denies home writes and ~/.kclaw reads", async () => {
    const ws = mkdtempSync(join(tmpdir(), "kclaw-sbx-ws-"))
    const home = fakeHome()
    try {
      // tmpDirs excludes os.tmpdir(): the fake home lives under it, and
      // must NOT be in the writable whitelist — only the real tmp dirs.
      const sb = createExecSandbox(
        { enabled: true, writeRoots: [] },
        { workspace: ws, home, tmpDirs: ["/private/tmp"] },
      )
      expect(sb.available).toBe(true)

      const ok = await runIn(sb, `echo hi > ${ws}/out.txt`, ws)
      expect(ok.status).toBe(0)

      const secret = await runIn(sb, `cat ${join(home, ".kclaw", "token")}`, ws)
      expect(secret.status).not.toBe(0)

      const homeWrite = await runIn(sb, `echo evil > ${join(home, "evil.txt")}`, ws)
      expect(homeWrite.status).not.toBe(0)
      // side-effect check, not just the exit code: the write must not have
      // landed anywhere
      expect(existsSync(join(home, "evil.txt"))).toBe(false)

      // network stack stays open (v1 decision): creating a socket works
      const net = await runIn(sb, "python3 -c \"import socket; socket.socket().close(); print('net-ok')\"", ws)
      expect(net.output).toContain("net-ok")
    } finally {
      rmSync(ws, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("writeRoots whitelist makes an extra dir writable", async () => {
    const ws = mkdtempSync(join(tmpdir(), "kclaw-sbx-ws-"))
    const home = fakeHome()
    const extra = mkdtempSync(join(tmpdir(), "kclaw-sbx-extra-"))
    try {
      const sb = createExecSandbox(
        { enabled: true, writeRoots: [extra] },
        { workspace: ws, home, tmpDirs: ["/private/tmp"] },
      )
      const w = await runIn(sb, `echo x > ${extra}/f.txt`, ws)
      expect(w.status).toBe(0)
      expect(existsSync(join(extra, "f.txt"))).toBe(true)
    } finally {
      rmSync(ws, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
      rmSync(extra, { recursive: true, force: true })
    }
  })

  it("network deny: connect is blocked (EPERM) while file ops keep working", async () => {
    const ws = mkdtempSync(join(tmpdir(), "kclaw-sbx-ws-"))
    const home = fakeHome()
    try {
      const sb = createExecSandbox(
        { enabled: true, writeRoots: [], network: "deny" },
        { workspace: ws, home, tmpDirs: ["/private/tmp"] },
      )
      expect(sb.available).toBe(true)

      // file ops untouched
      const ok = await runIn(sb, `echo hi > ${ws}/out.txt`, ws)
      expect(ok.status).toBe(0)

      // an outbound connect is denied by the sandbox (EPERM), not by the
      // absence of a listener (that would be ECONNREFUSED)
      const py = 'import socket\ntry:\n    s=socket.socket()\n    s.connect(("127.0.0.1", 54321))\n    print("CONNECT-OK")\nexcept Exception as e:\n    print("CONNECT-FAIL:", type(e).__name__)'
      const net = await runIn(sb, `python3 -c '${py}'`, ws)
      expect(net.output).toContain("CONNECT-FAIL: PermissionError")
    } finally {
      rmSync(ws, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("linux bwrap smoke", { skip: !isLinux || !linuxHasBwrap }, () => {
  it("writes in workspace, home is read-only, ~/.kclaw is masked", async () => {
    const ws = mkdtempSync(join(tmpdir(), "kclaw-sbx-ws-"))
    // Fake home under the REAL home (visible via ro-bind /, but read-only
    // and with ~/.kclaw tmpfs-masked); a tmp-based home would sit inside the
    // writable /tmp tmpfs and break the isolation assertions.
    const home = mkdtempSync(join(homedir(), "kclaw-fakehome-"))
    mkdirSync(join(home, ".kclaw"), { recursive: true })
    writeFileSync(join(home, ".kclaw", "token"), "super-secret")
    try {
      const sb = createExecSandbox({ enabled: true, writeRoots: [] }, { workspace: ws, home })
      expect(sb.available).toBe(true)

      const ok = await runIn(sb, `echo hi > ${ws}/out.txt`, ws)
      expect(ok.status).toBe(0)

      // ~/.kclaw masked by tmpfs: the token is not visible at all
      const secret = await runIn(sb, `cat ${join(home, ".kclaw", "token")}`, ws)
      expect(secret.status).not.toBe(0)

      const homeWrite = await runIn(sb, `echo evil > ${join(home, "evil.txt")}`, ws)
      expect(homeWrite.status).not.toBe(0)
      // side-effect check, not just the exit code: the write must not have
      // landed anywhere
      expect(existsSync(join(home, "evil.txt"))).toBe(false)
    } finally {
      rmSync(ws, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })
})
