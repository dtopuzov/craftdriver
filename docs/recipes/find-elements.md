# Find Elements On The Page

Everything you do with CraftDriver — click, fill, assert — starts by pointing at
an element. Before you can automate anything, you have to name the thing you
want. It's the first skill to learn, and it pays to learn it in the right order:
some ways of naming an element survive a redesign or a translation, and some
don't. This recipe starts with the anchors that hold up almost everywhere, then
the more expressive ones and where they earn their place.

It drives the live
[login example](https://dtopuzov.github.io/craftdriver/examples/login.html).

## Inspect the page first

Open the page in a real browser, right-click the element you care about, and
choose **Inspect**. Then look for a handle, roughly in this order:

1. **A stable attribute you can anchor to** — a form field's `name`, an input
   `type`, a hand-written `id`, or a `data-testid`. None of these change when the
   wording or the layout does.
2. **What the element is to a user** — its *role* (button, link, heading,
   checkbox) and its *accessible name* (its visible words, or an input's
   `<label>`).
3. **Its visible text**, when that's the thing that identifies it.

The login form, inspected, has ids and `name`s on the fields and a typed submit
button:

```html
<h1>Login</h1>
<label for="username">Username</label>
<input id="username" name="username" />
<label for="password">Password</label>
<input id="password" name="password" />
<button id="submit" type="submit">Sign in</button>
```

## Start with anchors that don't move

Some anchors don't change when the copy changes, because they aren't copy — a
form field's `name` is a backend contract, an input `type` is semantic, a
hand-written `id` is put there on purpose. Reach for these first: they read
clearly, they survive redesigns, and they resolve the same whether the page ships
in English or German.

```ts
// Fields by their `name` — a form contract, not UI text
await browser.find(By.name('username')).fill('alice');
await browser.find(By.name('password')).fill('secret');

// The submit button by its semantic type
await browser.find('button[type="submit"]').click();

// The result by its stable id
await browser.locator('#welcome').expect().toBeVisible();
```

Each has a boundary worth knowing: `name` and `type` live mostly on form
controls, so they won't help you point at a heading or a menu item; and an `id`
is only trustworthy when it's authored for meaning — framework-generated ids like
`#mui-4213` churn between builds, so never anchor to those.

A word on `data-testid`, since it comes up constantly. It's the most robust
anchor there is *when it's in the page you test* — invisible to users, untouched
by redesign or translation. But test ids aren't a browser or "dev mode" feature;
they're attributes a team chooses to add, and some builds strip them to trim the
payload. So don't assume they exist: open the real production DOM and look. If
you own the app, add them and make sure the production build keeps them; if you
don't, lean on `name`, `type`, and honest semantic HTML — those are always
shipped.

## Match the way a user sees the page

The anchors above are *plumbing* — attributes wired into the markup. Sometimes
you want the opposite: to find an element the way a person, or a screen reader,
actually perceives it. That's what `getByRole`, `getByLabel`, and `getByText`
are for, and they read almost like a spoken description:

```ts
// "the Login heading"
await browser.getByRole('heading', { name: 'Login' }).expect().toBeVisible();

// "the Username / Password fields", found through their <label>
await browser.getByLabel('Username').fill('alice');
await browser.getByLabel('Password').fill('secret');

// "the Sign in button", by role + accessible name
await browser.getByRole('button', { name: 'Sign in' }).click();

// "the welcome message", by its visible text
await browser.getByText('Welcome back, alice!').expect().toBeVisible();
```

The match is meaningful, not just readable: if your test can find the button by
its role and name, the page is exposing the semantics users depend on. These
locators also shrug off markup refactors, since they don't care how many `<div>`s
wrap the element.

Pitfalls worth knowing:

- **They rely on correct semantic HTML.** `getByRole('button')` finds a real
  `<button>`, not a `<div onclick>`. That's often a bug worth surfacing — but it
  means these locators expose how honest your markup is.
- **The name is usually user-facing text**, so it's tied to the current language
  — see the next section.
- **Name matching is an approximation.** CraftDriver handles the common cases
  (`aria-label`, simple `aria-labelledby`, visible text, form labels, `alt`,
  `title`), but if a role query is fussy, use `getByLabel`, `getByTestId`, or a
  stable attribute instead of guessing.

## Working across languages

Here's the catch these accessibility locators carry: the *name* you match on is
translated text. `getByLabel('Username')` finds nothing on a page that renders
`Benutzername`. Two honest ways to handle it:

- **Anchor on the language-neutral attributes from the top of this page** —
  `name`, `type`, id, test id. The same test then runs in every locale unchanged.
  It's the simplest thing that works, and where most localised suites end up.
- **Feed the locator from the same translations the app uses** —
  `getByRole('button', { name: t('auth.signIn') })`. You keep the accessibility
  benefits *and* run per-locale. The cost is discipline: the test has to read the
  exact key the UI renders, and you run it once per language — otherwise a
  translation change quietly becomes a false failure.

A rule that applies either way: **a bare string is always a CSS selector**. To
match by text or role you must use a `getBy*` method or a `By.*` locator; there's
no `text=` string shorthand.

## Notes

- Names match the **whole** text by default. Pass `{ exact: false }` to match a
  substring, e.g. `getByText('Welcome back', { exact: false })`.
- To search *inside* one card or row instead of the whole page, chain from a
  [locator](../selectors.md#locators-lazy--chainable):
  `card.getByRole('button', { name: 'Buy' })`.

## Learn More

- [Selectors & Locators](../selectors.md) — the full reference for every strategy
- [Organize Flows With Page Objects](./page-objects.md)
- [Assertions](../assertions.md)
