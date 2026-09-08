# Static preview

`index.html` is the storefront Worker's rendered output for `/`, captured verbatim so the
preview cannot drift from what deploys. Self-contained: no external requests, no fonts, no
scripts.

Regenerate after any storefront change:

```sh
cd store
npx wrangler dev --local --port 8801 &
curl -s localhost:8801/ > ../docs/preview/index.html
```

## Serving it publicly

**GitHub Pages.** Settings → Pages → Source: *Deploy from a branch* → branch `main`, folder
`/docs`. The page is then at `https://<owner>.github.io/vemians/preview/`.

Note `vemians` is a **private** repository, and GitHub Pages only serves publicly from a
private repo on a paid plan. On Free, either make the repo public or use one of the other two
routes below.

**Cloudflare `workers.dev`** — the real thing rather than a snapshot, and no DNS required:

```sh
cd store && npx wrangler deploy
```

**A published Artifact** — no machine needed, but private until shared from the page's share
menu.
