# Tool Filtering Test

Purpose: prove unsafe downstream tools are hidden before VS Code/Copilot sees them.

## Automated Test

```bash
npm test
```

Expected:

```text
ok - tool filter hides unsafe tools by default before MCP tools/list
ok - gateway boots, exposes control status, proxies fake echo, filters unsafe tools, and recovers
```

## Manual Test

Start the Extension Development Host with `F5`.

In the Connections panel:

1. Right-click `Test Echo`.
2. Choose `Simulate Connection State`.
3. Pick `unsafe_tools`.

Expected control-plane status:

```bash
# Use the port shown in Output > Managed Connections Gateway
PORT=51234
curl -s -H "Authorization: Bearer <token>" \
  http://127.0.0.1:$PORT/control/status
```

The internal status should include hidden tools:

```json
{
  "name": "shell_exec",
  "isVisible": false,
  "isSafe": false,
  "hiddenReason": "Hidden because it can run code..."
}
```

Expected MCP `tools/list` exposed to Copilot:

- includes `test-echo__echo`
- includes `test-echo__get_fake_data`
- includes `test-echo__get_connection_marker`
- does not include `test-echo__shell_exec`
- does not include `test-echo__delete_files`
- does not include `test-echo__browser_run_code_unsafe`

## Assistant Prompt

```text
List the tools available through the managed gateway. Are any advanced or unsafe tools hidden?
```

Expected answer:

```text
The safe Test Echo tools are available. Some advanced tools are hidden by safety policy because they can run code or modify files.
```

## Pass Criteria

- Fake downstream exposes safe and unsafe tools in `unsafe_tools` mode.
- Gateway internal status reports unsafe tools as hidden.
- MCP `tools/list` only includes safe visible tools.
- Unsafe tools cannot be invoked through the gateway.
- Blocked invocations return an MCP error result instead of executing.
- User-facing status uses normal words, not protocol errors.

## Unsafe Fixture Tools

- `shell_exec`
- `delete_files`
- `browser_run_code_unsafe`

These tools exist only in `packages/fake-mcp-server` for proof/testing. They should never be exposed to Copilot by default.
