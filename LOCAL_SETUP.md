# Local CloudCLI setup

CloudCLI runs from this checkout, `/workplace/nganhpha/console` (also
`~/workplace/console`), on branch `cloudcli`, published as `origin/cloudcli`
in `pha-nguyen/claude-console`. The `cloudcli` remote points to upstream
`siteboon/claudecodeui`; this branch is based on version `1.37.3`, commit `dc7cb6c`.
The original console history remains on branch `main`.

## Files

The setup files and app data moved from temporary storage are under this checkout:

| Purpose | Location |
| --- | --- |
| App configuration | `.env` |
| User service definition | `infra/cloudcli-console.service` |
| Authentication database and session index | `.local/cloudcli/auth.db` |
| Local login details | `.local/cloudcli/login.json` |
| Import mappings and verification results | `.local/cloudcli/import-report.json` |
| Original console database backup | `.local/cloudcli/claude-console-before-import.db` |
| Import and browser verification scripts | `.local/cloudcli/import-console-sessions.py`, `.local/cloudcli/browser-check.mjs` |
| Server output | `.local/cloudcli/server-service.log` |
| Build, install, typecheck, lint, and session-test logs | `.local/cloudcli/cloudcli-*.log` |
| Original console dependencies | `.local/cloudcli/claude-console-runtime/node_modules` |

`.env` and `.local/cloudcli/` are excluded from Git. The private data directory
has mode 0700, and the login details have mode 0600.
Claude's native transcripts and settings stay in their existing home-directory
locations; CloudCLI indexes those histories in place.

## Access and service management

Open `http://localhost:3000` on this host. Forward port 3000 when connecting
remotely. The local username is `nganhpha`; its password is in the login file above.

The user service is linked to the service definition in this repository and
enabled for automatic startup with your user service manager.

```sh
systemctl --user status cloudcli-console
systemctl --user restart cloudcli-console
systemctl --user stop cloudcli-console
```

To register the service again:

```sh
systemctl --user link ~/workplace/console/infra/cloudcli-console.service
systemctl --user daemon-reload
systemctl --user enable --now cloudcli-console
```

For a foreground launch after stopping the service:

```sh
cd ~/workplace/console
npm run server
```

The installed Node runtime is `25.8.0`; the service selects it explicitly.

## Imported conversations

The import restored seven project names and 15 distinct saved conversations,
representing 18 of the old console's 22 entries, including all 17 entries marked
`running`. Entries sharing a conversation ID were combined while preserving their
labels. Four older stopped entries lacked corresponding saved transcripts; the
full details are in the private import report.

Running terminal processes from the old console are not transferred. Open a saved
conversation in CloudCLI to view its history and use its resume workflow.
CloudCLI also discovers other native Claude and Codex histories automatically.

## Validation and known limitations

- The production build, typecheck, and all 690 frontend tests passed.
- Focused backend model and shell tests passed.
- All 15 imported histories returned messages through the app's API.
- Browser login and all seven project names were verified.
- Opening `spatial_review` loaded its 15 messages without JavaScript errors.
- Lint passed with upstream warnings.
- The native Terminal tab opened zsh in the project directory and retained its
  process across tab switches; desktop and mobile layouts were checked.
- Clipboard copying preserved code whitespace. Mac textbox navigation was
  checked with macOS detection simulated in Chromium and Firefox on Linux;
  native macOS and Safari testing were unavailable.

CloudCLI invokes `/home/nganhpha/.toolbox/bin/claude` and loads user, project, and
local Claude settings, including the existing Bedrock configuration and AWS
credential hooks. Its upstream login-status checker recognizes Anthropic API keys
and OAuth but does not recognize Bedrock authentication. Saved-history viewing
was verified; live model execution remains untested.
