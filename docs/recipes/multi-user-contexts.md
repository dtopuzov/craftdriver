# Test Multi-User Workflows

Use this pattern for chat, permissions, approvals, collaboration, admin/customer
flows, or any test where two signed-in users must exist at the same time.

Browser contexts isolate cookies and storage while sharing one launched browser.

```ts
import { afterAll, beforeAll, describe, it } from 'vitest';
import { Browser } from 'craftdriver';

describe('team invitation', () => {
  let browser: Browser;
  const baseUrl = 'http://localhost:3000';

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: 'chrome' });
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('admin invites a teammate who accepts in another context', async () => {
    const admin = await browser.newContext({ storageState: '.auth/admin.json' });
    const teammate = await browser.newContext({ storageState: '.auth/alice.json' });

    try {
      const adminPage = await admin.newPage({ url: `${baseUrl}/team` });
      await adminPage.find('#invite-member').click();
      await adminPage.find('#invite-email').fill('alice@example.com');
      await adminPage.find('#send-invite').click();
      await adminPage.expect('#invite-status').toContainText('Sent');

      const alicePage = await teammate.newPage({ url: `${baseUrl}/invites` });
      await alicePage.find('#accept-invite').click();
      await alicePage.expect('#membership').toContainText('Member');

      await adminPage.find('#refresh-members').click();
      await adminPage.expect('#member-list').toContainText('alice@example.com');
    } finally {
      await admin.close();
      await teammate.close();
    }
  });
});
```

## Notes

- Use one context per user or role.
- Put context cleanup in `finally` so failed assertions do not leak sessions.
- Combine with saved storage state when users should start already signed in.

## Learn More

- [Browser Contexts](../browser-context.md)
- [Session Management](../session-management.md)
