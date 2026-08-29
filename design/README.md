# RASTA — Design Checkpoints

This directory preserves **approved** design source alongside the backend commit it was
verified against. It is documentation, not application code.

```text
design/
├── README.md
├── source/
│   ├── RASTA-Web-Portal.dc.html   design source (all portal surfaces)
│   └── support.js                 generated Design Component runtime (required)
├── handoff/
│   ├── maintenance.md             implementation handoff for the Maintenance domain
│   └── mobile.md                  implementation handoff for the mobile-responsive experience
└── screenshots/
    ├── maintenance/
    └── mobile/
```

---

## 1. Source format, and what it is not

`RASTA-Web-Portal.dc.html` is a **Design Component** source file: markup, inline styles
and one plain-JavaScript logic class in a single HTML document.

**It is not a self-contained artifact.** It does not open correctly on its own:

- It **requires the sibling `support.js`** to render anything at all.
- `support.js` is a **generated Design Component runtime**, not hand-written code.
- The runtime **dynamically evaluates** the Design Component logic embedded in the HTML.
- The runtime carries **pinned CDN fallbacks** for React 18.3.1, ReactDOM 18.3.1 and
  Babel Standalone 7.29.0, which it loads if those globals are not already present.
- The HTML **separately** loads Lucide 0.469.0 from unpkg for icons.
- **Offline behaviour differs.** If the runtime dependencies are not already bundled or
  cached, the page will not render; without Lucide only the icon glyphs are missing.

**This runtime exists to view the design specification, nothing else.** It must never be
copied into, bundled with, or served as the RASTA production frontend. Production
engineers reimplement the approved behaviour on the real application stack against the
backend contracts — this file is the specification, not a starting codebase.

### How to open it

Serve the `source/` directory over HTTP and open `RASTA-Web-Portal.dc.html`
(for example `python3 -m http.server` from inside `source/`). Opening it over `file://`
may fail, because the document fetches its sibling runtime. Screens are switched from
the left rail inside the document; there is no router.

---

## 2. Fonts

The production design uses **Vazir** and **Estedad**. Those font binaries are **not
redistributed in this checkpoint**, because their licence files were not available at
export time and unlicensed binaries must not be committed.

**Chosen option: A — the unresolved local `@font-face` declarations were removed** and
replaced with an explicit portable Persian system stack:

```css
'Vazirmatn', 'Vazir', 'Estedad', 'Noto Naskh Arabic', 'Segoe UI', Tahoma, system-ui, sans-serif
```

If Vazirmatn, Vazir or Estedad is installed locally, the design renders in the intended
typeface. Otherwise it falls back to the platform's Persian UI font. **Metrics differ
slightly** from production — line lengths and a few wrap points move — but layout,
spacing and behaviour are unaffected. The checkpoint was reopened after the change and
verified to render correctly. There are **no unresolved font requests** in this package.

To restore the exact production typeface, add the licensed font files under
`source/fonts/` together with their licence files and reinstate the `@font-face` rules.

---

## 3. Complete external-resource inventory

Everything this package loads at runtime:

| Resource                                                                | Loaded by               | Version                 | Pinned           | Integrity metadata                                       |
| ----------------------------------------------------------------------- | ----------------------- | ----------------------- | ---------------- | -------------------------------------------------------- |
| `./support.js`                                                          | the HTML, relative path | ships in this directory | n/a (local file) | none                                                     |
| Lucide icons — `unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js`        | the HTML                | 0.469.0                 | yes              | **no** SRI attribute                                     |
| React — `unpkg.com/react@18.3.1/umd/react.production.min.js`            | `support.js` fallback   | 18.3.1                  | yes              | SRI applied when the runtime supplies a hash for the URL |
| ReactDOM — `unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js` | `support.js` fallback   | 18.3.1                  | yes              | as above                                                 |
| Babel Standalone — `unpkg.com/@babel/standalone@7.29.0/babel.min.js`    | `support.js` fallback   | 7.29.0                  | yes              | as above                                                 |
| Fonts                                                                   | none                    | —                       | —                | —                                                        |

All five URLs are version-pinned. The Lucide tag in the HTML carries **no** `integrity`
attribute. The runtime's script loader sets `integrity` and `crossOrigin="anonymous"`
only when a hash is available for the URL it is loading. **Lucide is not the only
external dependency** — the React, ReactDOM and Babel fallbacks are equally real.

---

## 4. Generated runtime disclosure — `support.js`

- It is **generated code**, produced by the Design Component tooling.
- It performs **dynamic evaluation** — this is required for the runtime to execute the
  logic class embedded in the `.dc.html` document, and it is inherent to the format.
- It also creates `<script>` elements at runtime to load the pinned CDN fallbacks.
- It is **not production application code** and must **not** be reused in `apps/web` or
  any other application package.
- Treat it as an **inspectable design artifact**: read it, review it, do not import it.
- **Static-security tooling may flag it** for dynamic evaluation and dynamic script
  creation. Those findings are expected for this file and describe real behaviour. The
  security-related comments and suppression markers inside the file (for example the
  `nosemgrep` note above the script loader) are **deliberately left in place** — do not
  strip them, and do not present the file as free of dynamic evaluation.

---

## 4a. Checkpoint integrity — SHA-256

Computed over the exported files in this directory:

| File                              | Bytes  | SHA-256                                                            |
| --------------------------------- | ------ | ------------------------------------------------------------------ |
| `source/RASTA-Web-Portal.dc.html` | 305686 | `cd425a5fedf70723125cfb797762f2581a2a1123558f12be627afafc0d1f79a8` |
| `source/support.js`               | 69150  | `8fe7df74405f3c55f49b7249c74ea1397e65d07dea2b1bd3b4a489bec2e28cbe` |

---

## 5. Relationship between backend commit and design checkpoint

Each checkpoint names the backend commit it was synchronised against. This checkpoint is
bound to **`e4f9b1e7867bac701fba49caec8a1e76697981e7`** on `main`.

Between that commit and `main` (read 2026-08-29), a complete `services/economic-service` and
ADR-030…ADR-034 were added upstream. **This checkpoint does not represent economic or marketplace as
implemented** — those surfaces remain `PLANNED` by instruction, and re-grounding them is a separate
approval-gated task.

**Backend code and API contracts remain the functional source of truth.** Where this
design and the code disagree, the code is right and the design is stale — raise it as a
finding rather than implementing the design.

---

## 6. Rules for this directory

1. Only **approved** design checkpoints are committed here. Work in progress stays out.
2. Planned or unbuilt UI must never be presented as implemented. Every surface carries a
   status strip reading `IMPLEMENTED`, `PARTIAL`,
   `IMPLEMENTED IN BACKEND · ready for frontend`, or `PLANNED`. Marketplace, economic,
   procurement, supplier, construction, contract and notification surfaces are design
   specification only and are marked `PLANNED`. Order-cycle copy follows the temporary
   decision recorded in `docs/24-open-questions.md` Q-11: a three-day confirmation
   window, **no automatic confirmation**, and no settlement triggered merely because the
   window expired.
3. No caches, exports, session data, credentials, tokens or generated noise.
4. A checkpoint is added, never silently rewritten — a new backend baseline means a new
   handoff entry naming the new commit.

---

## 7. Adding a future domain checkpoint

1. Sync the design against the domain's real code first, and record the findings.
2. Update the design source in `source/` if the sync changed it.
3. Add `handoff/<domain>.md` following the shape of `handoff/maintenance.md` or `handoff/mobile.md`: metadata
   and backend commit, surfaces represented, routes, API-to-UI mapping, lifecycle and
   states, roles, validation, cross-domain effects, deferred capabilities, and an honest
   verification statement.
4. Add screenshots under `screenshots/<domain>/` only if they are reliable and carry no
   session or personal data.

---

## 8. How a frontend engineer should use these files

1. Read `handoff/<domain>.md` first. It maps every screen element to the endpoint that
   feeds it and lists the states the API can actually produce.
2. Open the source to see layout, spacing, typography and copy — the visual and
   behavioural specification, not code to copy into the app.
3. Verify every field name and enum against the service's DTOs before building. The
   handoff names the files to check.
4. Anything the handoff lists as deferred does not exist in the backend. Do not build a
   screen for it.
