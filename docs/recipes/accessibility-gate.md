# Run Accessibility Gates

Use this pattern when CI should reject serious accessibility regressions, while
still allowing deliberate rule exceptions in one place.

```ts
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { Browser } from 'craftdriver';

const A11Y_OPTIONS = {
  minImpact: 'serious' as const,
  disableRules: [
    // Example: keep temporary exceptions explicit and reviewed.
    'color-contrast',
  ],
};

describe('accessibility gate', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: 'chrome' });
  });

  beforeEach(async () => {
    await browser.navigateTo('http://localhost:3000/settings');
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('passes page-level accessibility checks', async () => {
    await browser.a11y.check(A11Y_OPTIONS);
  });

  it('passes modal accessibility checks', async () => {
    await browser.getByRole('button', { name: 'Edit profile' }).click();
    await browser.locator('#profile-modal').a11y.check(A11Y_OPTIONS);
  });
});
```

## Notes

- Use `check()` when violations should fail the test.
- Use `audit()` when you want to write a report or inspect violations manually.
- Prefer scoped checks for dynamic UI such as dialogs, menus, and checkout panels.

## Learn More

- [Accessibility](../accessibility.md)
- [Selectors](../selectors.md)
