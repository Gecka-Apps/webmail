import { render, act, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { clearAllHooks } from '@/lib/plugin-hooks';

// How a received message is shown: the body frame's name and language, and
// the reading settings that reach the body.

const t = Object.assign(
  (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  { raw: (key: string) => key, rich: (key: string) => key, has: () => true },
);
vi.mock('next-intl', () => ({
  useTranslations: () => t,
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: (d: Date | string) => String(d), relativeTime: (d: Date | string) => String(d), number: (n: number) => String(n) }),
}));
const media = vi.hoisted(() => ({ matches: new Set<string>() }));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: (query: string) => media.matches.has(query),
  useIsMobile: () => false,
  useIsDesktop: () => true,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');
const { useSettingsStore } = await import('@/stores/settings-store');
const { ACCESSIBILITY_DEFAULTS } = await import('@/lib/accessibility-settings');
const { useThemeStore } = await import('@/stores/theme-store');
const { DARK_PENDING_CLASS } = await import('@/lib/email-dark-mode');

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

function message(overrides: Partial<Email> & { html?: string; text?: string } = {}): Email {
  const { html, text, ...rest } = overrides;
  const bodyValues: Record<string, { value: string }> = {};
  if (html !== undefined) bodyValues.h = { value: html };
  if (text !== undefined) bodyValues.t = { value: text };
  return {
    id: 'm1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
    from: [{ name: 'Alice', email: 'alice@example.com' }], to: [{ name: 'Bob', email: 'bob@example.com' }],
    subject: 'Bonjour', receivedAt: '2026-01-01T00:00:00Z', preview: 'Hello', hasAttachment: false, size: 100,
    htmlBody: html !== undefined ? [{ partId: 'h', type: 'text/html' }] : [],
    textBody: text !== undefined ? [{ partId: 't', type: 'text/plain' }] : html !== undefined ? [{ partId: 'h', type: 'text/html' }] : [],
    attachments: [],
    bodyValues,
    ...rest,
  } as unknown as Email;
}

async function show(email: Email) {
  const view = render(
    <EmailViewer email={email} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />,
  );
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return view;
}

beforeEach(() => {
  clearAllHooks();
  media.matches.clear();
  useSettingsStore.setState({ ...ACCESSIBILITY_DEFAULTS, fontSize: 'medium', emailAlwaysLightMode: false } as never);
  useThemeStore.setState({ resolvedTheme: 'light' });
});

describe('message body frame', () => {
  it('is named after the subject and carries the mail language', async () => {
    const { container } = await show(message({
      html: '<html lang="fr"><body><p>Bonjour tout le monde</p></body></html>',
    }));
    const iframe = container.querySelector('iframe')!;
    expect(iframe.getAttribute('title')).toBe('frame_title {"subject":"Bonjour"}');
    expect(iframe.getAttribute('srcdoc')).toMatch(/^<!DOCTYPE html>\s*<html lang="fr"/);
  });

  it('is named after the sender when there is no subject, with no language guessed', async () => {
    const { container } = await show(message({ subject: '', html: '<p>Hi there, <b>friend</b></p>' }));
    const iframe = container.querySelector('iframe')!;
    expect(iframe.getAttribute('title')).toBe('frame_title_from {"sender":"Alice"}');
    expect(iframe.getAttribute('srcdoc')).not.toMatch(/<html[^>]*\slang=/);
  });

  it('marks a plain-text body with its Content-Language', async () => {
    await show(message({ text: 'Hallo zusammen', textBody: [{ partId: 't', type: 'text/plain', language: ['de'] }] as never }));
    expect(screen.getByText('Hallo zusammen').closest('[lang]')?.getAttribute('lang')).toBe('de');
  });
});

describe('attachment actions', () => {
  it('name the file they act on', async () => {
    await show(message({
      html: '<p>See the <b>attached</b> report</p>',
      hasAttachment: true,
      attachments: [{ partId: '2', blobId: 'blob2', name: 'report.pdf', type: 'application/pdf', size: 2048 }] as never,
    }));
    expect(screen.getAllByRole('button', { name: 'download_named {"name":"report.pdf"}' }).length).toBeGreaterThan(0);
  });
});

describe('message text size', () => {
  it('plain text follows the mail text size and its minimum instead of a fixed 14px', async () => {
    useSettingsStore.setState({ mailTextScale: 1.5, mailMinFontSize: 16 } as never);
    await show(message({ text: 'Plain words here' }));
    const body = screen.getByText('Plain words here').closest('.email-content-text') as HTMLElement;
    // jsdom folds the calc().
    expect(body.style.fontSize).toMatch(/^max\(.*(0\.875rem \* 1\.5|1\.3125rem).*, 16px\)$/);
  });

  it('plain text follows the app text size by default', async () => {
    useSettingsStore.setState({ fontSize: 'xx-large' } as never);
    await show(message({ text: 'Plain words here' }));
    const body = screen.getByText('Plain words here').closest('.email-content-text') as HTMLElement;
    expect(body.style.fontSize).toBe('0.875rem');
  });

  it('rebuilds the HTML frame for a new size', async () => {
    useSettingsStore.setState({ fontSize: 'xx-large' } as never);
    const { container } = await show(message({ html: '<p>Some <b>formatted</b> text</p>' }));
    expect(container.querySelector('iframe')!.getAttribute('srcdoc')).toContain('data-reading="1.5/0"');
  });
});

describe('forced colours', () => {
  it('dark theme recolours the mail normally', async () => {
    useThemeStore.setState({ resolvedTheme: 'dark' });
    const { container } = await show(message({ html: '<p>Some <b>formatted</b> text</p>' }));
    expect(container.querySelector('iframe')!.getAttribute('srcdoc')).toContain(DARK_PENDING_CLASS);
  });

  it('skips our dark recolouring when the browser forces colours', async () => {
    useThemeStore.setState({ resolvedTheme: 'dark' });
    media.matches.add('(forced-colors: active)');
    const { container } = await show(message({ html: '<p>Some <b>formatted</b> text</p>' }));
    const srcdoc = container.querySelector('iframe')!.getAttribute('srcdoc')!;
    expect(srcdoc).not.toContain(DARK_PENDING_CLASS);
    expect(srcdoc).not.toContain('forced-color-adjust');
  });
});
