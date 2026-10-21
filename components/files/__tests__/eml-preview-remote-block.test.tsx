import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

const config = vi.hoisted(() => ({ remoteContentProxyEnabled: false }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => config }));

import { EmlPreview } from '../eml-preview';
import { useSettingsStore } from '@/stores/settings-store';

// The .eml attachment preview sanitized the body but never blocked remote
// content and set no CSP, so opening an attached message fired its trackers
// whatever the user's remote-content policy said.

const HTML = '<p>x</p><img src="https://t.example/pixel.gif"><img srcset="https://t.example/srcset.gif 1x">';

function srcdoc(): string {
  const { container } = render(
    <EmlPreview message={{ subject: 's', html: HTML, attachments: [] }} />,
  );
  return container.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
}

afterEach(() => {
  useSettingsStore.setState({ externalContentPolicy: 'ask' });
  config.remoteContentProxyEnabled = false;
});

describe('EmlPreview remote content', () => {
  it('blocks remote images and sets the strict CSP by default', () => {
    const doc = srcdoc();
    expect(doc).not.toMatch(/\s(src|srcset)="https:\/\/t\.example/);
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(doc)?.[1] ?? '';
    expect(csp).toContain("img-src data: blob:;");
    expect(doc).toContain('<meta name="referrer" content="no-referrer">');
  });

  it('loads them when the user allows remote content everywhere', () => {
    useSettingsStore.setState({ externalContentPolicy: 'allow' });
    expect(srcdoc()).toContain('src="https://t.example/pixel.gif"');
  });

  it('keeps them blocked with the remote-content proxy on, which cannot serve the sandboxed frame', () => {
    useSettingsStore.setState({ externalContentPolicy: 'allow' });
    config.remoteContentProxyEnabled = true;
    const doc = srcdoc();
    expect(doc).not.toMatch(/\s(src|srcset)="https:\/\/t\.example/);
    expect(/Content-Security-Policy" content="([^"]*)"/.exec(doc)?.[1]).toContain("img-src data: blob:;");
  });
});

describe('EmlPreview attachment names', () => {
  it('show without directional override characters', () => {
    const { getByText, queryByText } = render(
      <EmlPreview message={{ subject: 's', text: 'x', attachments: [{ filename: 'report‮fdp.exe', mimeType: 'application/octet-stream' }] }} />,
    );
    expect(getByText('reportfdp.exe')).toBeTruthy();
    expect(queryByText('report‮fdp.exe')).toBeNull();
  });
});
