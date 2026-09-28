---
name: testing-sessionboxer-ui
description: Test Sessionboxer's local browser UI using existing services, device login, real PR data, and responsive layouts.
---

# Local UI verification

- Consult the environment blueprint and preserve already-running services. UI-only verification does not require rebuilding the Sandbox image or restarting Docker containers.
- The Control Plane normally serves the built web UI at `http://127.0.0.1:4000`. Reload after the lead rebuilds the web bundle.
- Device-login credentials are stored in `~/.sessionboxer/config.json` as `accessToken`. Read this only inside the login script; never print or persist the token elsewhere. The browser can POST `{token, name}` to `/api/auth/login` with JSON content type, then reload.
- Existing Chrome may expose CDP at `http://localhost:29229`; use the configured endpoint and existing context. Keep the active tested page foregrounded when recording.
- Session PR overview route: `#/sessions/<session-id>/prs`. Row title opens detail; the Pull requests breadcrumb returns to the list.
- Global settings → Interface contains the color-theme radio controls. Disable Follow system before choosing a fixed palette, and restore the original preference afterward.

# PR pane caveats

- PR provider data is live. Watchers may change failure counts and threads during the test. Record actual totals rather than assuming a static fixture.
- Opening detail automatically marks loaded comments/checks seen, so unread tests should start from overview. The standalone Mark all seen button may already be disabled before a person can click.
- Address/Fix dispatch is available only for a PR belonging to the Session's Workspace. Non-local PRs still support To prompt.
- Placeholder agent credentials allow the UI to accept dispatch but cannot prove agent completion; an OAuth 401 in the transcript is then an environment limitation, not evidence that the dispatch UI failed.
- Auto-merge acts on real GitHub PRs. Only enable it when explicitly authorized, on a safely blocked PR, then immediately disable and verify it stayed off.
- React-controlled checkbox changes may finish asynchronously after the click/request; use a normal click followed by an explicit state assertion rather than assuming Playwright's immediate `check()` assertion is sufficient.
- Check overflow for `.prs-pane` at desktop and phone widths. A `.pr-row-icon` 19-pixel scroll width in a 16-pixel box is the decorative attention dot, not pane overflow.
- Wait for responsive-shell transitions before mobile screenshots. Otherwise a partially animated sidebar can appear in an otherwise correct layout.
- There is no per-item Dismiss action in the PR pane; Mark seen is the read-state action. A global notification close button may independently have the title Dismiss.

## Devin Secrets Needed

No organization secret is needed for an already-authenticated local device session. Use the existing device `accessToken`; real agent completion additionally requires a valid configured provider credential such as `CLAUDE_CODE_OAUTH_TOKEN`.
