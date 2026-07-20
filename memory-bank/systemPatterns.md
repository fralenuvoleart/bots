# System Patterns


## 🛠️ Developer Working Method
- **Standard:** Modular, elegant, SEO-performant.
- **Verification:** Trace every claim through the full call chain before asserting a pattern is followed or a regression is avoided — use `search_files`/grep, never assume from a function name or comment alone.
- **Zero Regression Policy:** Check this file before every file write to ensure changes don't violate an established architectural invariant above.

---

## 🌐 Sevalla API Rules (Hard-Learned)

### Exec endpoint (`POST /v3/applications/{id}/processes/{pid}/exec`)

| Rule | Detail |
|---|---|
| **Always check OpenAPI spec first** | `curl -s https://api.sevalla.com/v3/openapi.json` — search for the endpoint path. Never guess the schema. |
| `command` is an **array of strings** | `["npm","run","warmer"]` not `"npm run warmer"` |
| `timeout` is **1–60 seconds** (integer) | Default 15. Sending 300 returns 400. Max is 60. |
| **No shell features** | No pipes, redirects, `&`, `nohup`, globbing. Use `sh -c "..."` as workaround. |
| **Long-running commands need backgrounding** | Use `["sh","-c","nohup <cmd> &"]` with `timeout:5`. Otherwise command gets killed at timeout. |
| **Short commands** (`ls`, `npm run logs`, `echo`) | Fine to run directly with default timeout. |
| Response format | `{"stdout":"...","stderr":"...","exit_code":0}` — not `"output"` or `"error"` |

### Deployment & Process behavior

| Rule | Detail |
|---|---|
| **Bot 409 conflict on deploy** | Old pod + new pod both poll Telegram. Fix: retry `bot.launch()` on 409 with delay. |
| **`bot.launch()` is a Promise** | Must be `await`ed or `.catch()`ed. Unhandled rejection crashes process in Node.js v24. |
| **Warmer & bot share process** | Cron warmer dies if bot crashes. Manual `npm run warmer` spawns separate process. |
| **Exec into crashed pod fails** | If the main process crashes, there's nothing to exec into. Exec requires a running container. |

---

*This file describes durable architectural rules, not a changelog. When a pattern changes, update the entry in place.*
