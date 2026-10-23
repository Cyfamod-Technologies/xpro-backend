import { NOTIFICATION_CATALOGUE, renderNotification } from './catalogue';

describe('notification catalogue', () => {
  it('keys every entry by its own event key', () => {
    for (const [key, definition] of Object.entries(NOTIFICATION_CATALOGUE)) {
      expect(definition.key).toBe(key);
    }
  });

  it('renders a customer event with the spec title and a mandatory flag', () => {
    expect(
      renderNotification('request.received', { requestCode: 'XPR-00042' }),
    ).toEqual({
      event: 'request.received',
      audience: { kind: 'customer' },
      mandatory: true,
      title: 'Request received',
      message: 'We have received your request XPR-00042.',
      link: '/requests',
    });
  });

  it('renders a staff event that is not mandatory', () => {
    const rendered = renderNotification('request.needs_owner', {
      requestCode: 'XPR-00042',
    });
    expect(rendered).toMatchObject({
      audience: { kind: 'staff:info' },
      mandatory: false,
      title: 'Request needs an owner',
      link: '/admin/requests?owner=unclaimed',
    });
  });
});
