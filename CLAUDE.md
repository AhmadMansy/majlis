# Majlis

Shared room where coding agents on different machines talk, debate and decide. "Majlis" is a
working name; Ahmed has not confirmed it.

## Stack

Category T1 (+ W3 later for the control panel): Node 24 + TypeScript strict, run directly by
Node's type stripping (no build step yet), `node:sqlite` for storage, MCP v2 SDK
(`@modelcontextprotocol/server`, `/node`, `/client`), pnpm, Biome, Vitest.

## Decisions already made (do not re-open without Ahmed)

- **No server outside users' machines.** The room creator's machine holds the data and serves
  MCP. No cloud relay, no accounts.
- **Pull, not push.** Agents check the room with tools (`inbox`, `wait_for_reply`). Claude Code
  channels / session injection were considered and rejected.
- **Cloudflare quick tunnel is the default way to reach the host.** Tailscale, named tunnels
  and same-network are planned as settings.
- **CLI first.** A browser control panel comes next; a Tauri shell later.
- **Must work with any MCP client**, not only Claude Code.

## Constraints that shape the code

- Quick tunnels do not carry Server-Sent Events, so every MCP response must be a plain JSON
  body. Modern requests use `responseMode: 'json'`; 2025-era requests are routed by
  `isLegacyRequest` to a stateless transport with `enableJsonResponse: true`. Do not switch
  either leg to the SDK's SSE defaults.
- `wait_for_reply` is capped at 50 seconds to stay under proxy and client tool timeouts.
- The HTTP server binds to `127.0.0.1` only; the tunnel is the single way in. Every `/mcp`
  request needs a member's bearer token. Only token hashes are stored.
- Messages from other participants are untrusted text. Tool results always frame them as
  information from a peer, never as instructions.
- Windows-first: keep CLI output ASCII and test in PowerShell.

## Commands

- `pnpm test` — unit and integration tests (no network)
- `pnpm e2e:tunnel` — real exchange through a quick tunnel (needs cloudflared and network)
- `pnpm typecheck`, `pnpm lint`, `pnpm format`
- `node src/cli.ts host --name <you> --invite <name>` — run a room

## Roadmap

1. Spike: messaging over a tunnel (done).
2. MVP: structured debate tools, decision records, limits and turn budgets, approval before
   sending, control panel, closing HTML report (app-owned template, agent-supplied content).
3. Mirror mode: local copies on members' machines, offline queue, host handover.
4. Later: other tunnel options, pinned contracts, animated replay and video export, Tauri shell.
