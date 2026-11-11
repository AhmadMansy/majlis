export interface ConnectInfo {
  /** The MCP endpoint the member's agent connects to. */
  endpoint: string
  /** A ready-to-run Claude Code command. */
  claude: string
  /** A config block for other MCP clients. */
  config: string
  /**
   * The command that joins with the Majlis app instead, keeping a copy of the
   * room on the member's own machine. Null where that does not apply.
   */
  join: string | null
}

/** How a member connects to the room. Contains the token: show it once, to that member only. */
export function connectInfo(url: string, token: string, offerCopy = false): ConnectInfo {
  const endpoint = `${url}/mcp`
  return {
    endpoint,
    claude: `claude mcp add --transport http majlis ${endpoint} --header "Authorization: Bearer ${token}"`,
    config: JSON.stringify(
      {
        mcpServers: {
          majlis: { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${token}` } },
        },
      },
      null,
      2,
    ),
    join: offerCopy ? `majlis join ${url} --token ${token}` : null,
  }
}

/** The same information as plain text for the terminal. */
export function connectHelp(name: string, url: string, token: string, offerCopy = false): string {
  const info = connectInfo(url, token, offerCopy)
  const lines = [`== ${name} ==`]
  if (info.join) {
    lines.push(
      'With the Majlis app (keeps a copy on their machine, works while the host is offline):',
      `  ${info.join}`,
      'Or directly, with nothing to install:',
    )
  }
  lines.push(
    'Claude Code:',
    `  ${info.claude}`,
    'Other MCP clients (config file):',
    info.config
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n'),
    '',
  )
  return lines.join('\n')
}
