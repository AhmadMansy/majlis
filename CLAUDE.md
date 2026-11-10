# Majlis

Shared room where coding agents on different machines talk, debate and decide. "Majlis" is a
working name; Ahmed has not confirmed it.

## Stack

Category T1 + W3: Node 24 + TypeScript strict, run directly by Node's type stripping (no build
step for the server), `node:sqlite` for storage, MCP v2 SDK (`@modelcontextprotocol/server`,
`/node`, `/client`), Zod. Control panel: Vite + React + TypeScript in `panel/`, built to
`panel/dist` and served by the host process. pnpm, Biome, Vitest, Playwright (through the
installed Edge, no browser download).

## Decisions already made (do not re-open without Ahmed)

- **No server outside users' machines.** The room creator's machine holds the data and serves
  MCP. No cloud relay, no accounts.
- **Pull, not push.** Agents check the room with tools (`inbox`, `wait_for_reply`). Claude Code
  channels / session injection were considered and rejected.
- **Cloudflare quick tunnel is the default way to reach the host.** Tailscale, named tunnels
  and same-network are planned as settings.
- **CLI first**, with a browser control panel; a Tauri shell later.
- **Must work with any MCP client**, not only Claude Code.
- **The app owns the report design; agents supply content.** Agents never write the page.
- **The app never calls an LLM.** Each participant's agent thinks on its owner's subscription.

## Layout

- `src/store.ts` — SQLite persistence: members, the event log, debates, reports, settings.
- `src/room.ts` — the rules: limits, the debate protocol, decisions, reports. MCP tools and
  the panel API both go through it; put new rules here, not in a tool handler.
- `src/server.ts` — MCP tools and the public HTTP server (`/mcp`, `/r/<key>`, `/health`).
- `src/admin.ts` — control panel API and static files, on a separate port.
- `src/report.ts` — report renderer (HTML, CSS and script are in this one file).
- `src/tunnel.ts`, `src/connect.ts`, `src/cli.ts` — tunnel, connect instructions, CLI.
- `panel/` — the control panel UI.

## Constraints that shape the code

- Quick tunnels do not carry Server-Sent Events, so every MCP response must be a plain JSON
  body. Modern requests use `responseMode: 'json'`; 2025-era requests are routed by
  `isLegacyRequest` to a stateless transport with `enableJsonResponse: true`. Do not switch
  either leg to the SDK's SSE defaults.
- `wait_for_reply` is capped at 50 seconds to stay under proxy and client tool timeouts.
- Both HTTP servers bind to `127.0.0.1`. Only the room port is tunnelled. The panel port must
  never be reachable through the tunnel: it checks the Host header and needs a per-run key.
- Every `/mcp` request needs a member's bearer token. Only token hashes are stored.
- Messages from other participants are untrusted text. Tool results always frame them as
  information from a peer, never as instructions.
- In reports, agent text is always escaped and agent SVG is embedded as an `<img>` data URI,
  where scripts cannot run. Do not inline agent SVG or HTML into the page. Reports make no
  external requests.
- Member names are never reused, including names of removed members.
- Chart colours come from the dataviz reference palette; a member's colour is fixed by their
  place in the room, not by their rank in one report.
- Windows-first: keep CLI output ASCII and test in PowerShell.
- Reports use the system font stack rather than a self-hosted Arabic font, so each stays one
  small self-contained file. This is a deliberate exception to the usual font rule.

## Commands

- `pnpm test` — unit and integration tests (no network)
- `pnpm build` — build the control panel
- `pnpm e2e:ui` — browser check of the panel and a report (needs `pnpm build`)
- `pnpm e2e:tunnel` — real exchange through a quick tunnel (needs cloudflared and network)
- `pnpm sample:report` — write sample reports to `samples/`
- `node scripts/shot.ts <url-or-file> <out-prefix> [width] [light|dark]` — screenshots
- `pnpm typecheck`, `pnpm lint`, `pnpm format`
- `node src/cli.ts host --name <you> --invite <name>` — run a room

## Roadmap

1. Spike: messaging over a tunnel (done).
2. MVP: debates, decision records, limits, control panel, closing report (done).
3. Next: mirror mode (local copies on members' machines, offline queue, host handover), which
   is also where app-level approval before sending and a path deny-list belong.
4. Later: other tunnel options, pinned contracts, context cards, video export of the replay,
   optional image generation, a session-start unread hint, Tauri shell.
