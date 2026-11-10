export interface ConnectInfo {
  /** The MCP endpoint the member's agent connects to. */
  endpoint: string
  /** A ready-to-run Claude Code command. */
  claude: string
  /** A config block for other MCP clients. */
  config: string
}

/** How a member connects their agent to the room. Contains the token: show it once, to that member only. */
export function connectInfo(url: string, token: string): ConnectInfo {
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
  }
}

/** The same information as plain text for the terminal. */
export function connectHelp(name: string, url: string, token: string): string {
  const info = connectInfo(url, token)
  return [
    `== ${name} ==`,
    'Claude Code:',
    `  ${info.claude}`,
    'Other MCP clients (config file):',
    info.config
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n'),
    '',
  ].join('\n')
}
