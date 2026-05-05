---
applyTo: "examples/**"
---

# Example HTML pages

Files in `examples/` are static test fixtures, served by `http-server` on
`http://127.0.0.1:8080` via `npm run examples:start`. They are **not**
user-facing documentation.

URL pattern: `http://127.0.0.1:8080/<filename>.html`.

## Conventions

- **One page per feature, named to match the test.** A test file
  `tests/foo.test.ts` looks for `examples/foo.html` first. Reuse an
  existing page (e.g. `login.html`, `dynamic.html`, `selectors.html`,
  `network.html`) before creating a new one.
- **Stable selectors.** Every interactive element gets a unique `id`.
  Tests select by `#id`; class-based or position-based selectors are
  fragile.
- **Self-contained.** No CDN links, no frameworks, no build step. Vanilla
  HTML and inline `<script>` only.
- **Includes a `<title>`.** Some tests assert on `browser.title()`.
- **Comments mark sections.** A short HTML comment above each block
  ("`<!-- happy path -->`") makes intent obvious.

## Minimal template

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Feature Name</title>
</head>
<body>
  <h1>Feature Name</h1>

  <!-- happy path -->
  <button id="trigger-btn">Trigger</button>
  <div id="result" hidden>Done</div>

  <script>
    document.getElementById('trigger-btn').addEventListener('click', () => {
      document.getElementById('result').hidden = false;
    });
  </script>
</body>
</html>
```

## Before committing a new page

- Open it manually with the examples server running and confirm every
  scripted interaction works.
- Confirm every selector the matching test uses actually exists on the
  page.

