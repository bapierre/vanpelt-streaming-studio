// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatMessage } from '@streamhub/shared/testing';
import { isNearBottom } from './ChatPanel';
import { ChatPanel } from './ChatPanel';

afterEach(cleanup);

const noop = () => {};

describe('ChatPanel', () => {
  it('renders chat text literally', () => {
    const evil = '<img src=x onerror="window.pwned=1">';
    const { container } = render(
      <ChatPanel messages={[chatMessage({ text: evil, fragments: [{ kind: 'text', text: evil }] })]} featuredId={null} onFeature={noop} onClearFeature={noop} />,
    );
    expect(screen.getByText(evil)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows https emotes as images and does not load non-https emote urls', () => {
    const { container } = render(
      <ChatPanel
        messages={[
          chatMessage({
            fragments: [
              { kind: 'emote', name: 'Kappa', url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/2.0' },
              { kind: 'emote', name: 'Evil', url: 'javascript:alert(1)' },
            ],
          }),
        ]}
        featuredId={null}
        onFeature={noop}
        onClearFeature={noop}
      />,
    );
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.getAttribute('alt')).toBe('Kappa');
    expect(screen.getByText('Evil')).toBeTruthy();
  });

  it('labels the platform, including YouTube', () => {
    render(<ChatPanel messages={[chatMessage({ id: 'youtube:1', platform: 'youtube' })]} featuredId={null} onFeature={noop} onClearFeature={noop} />);
    expect(screen.getAllByText('YouTube').length).toBeGreaterThan(0);
  });

  it('filters by platform', () => {
    render(
      <ChatPanel
        messages={[chatMessage({ id: 'twitch:1', text: 'from twitch', fragments: [{ kind: 'text', text: 'from twitch' }] }), chatMessage({ id: 'youtube:1', platform: 'youtube', text: 'from yt', fragments: [{ kind: 'text', text: 'from yt' }] })]}
        featuredId={null}
        onFeature={noop}
        onClearFeature={noop}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Twitch' }));
    expect(screen.queryByText('from twitch')).toBeNull();
    expect(screen.getByText('from yt')).toBeTruthy();
  });

  it('features and un-features a message', () => {
    const onFeature = vi.fn();
    const onClear = vi.fn();
    const m = chatMessage();
    const { rerender } = render(<ChatPanel messages={[m]} featuredId={null} onFeature={onFeature} onClearFeature={onClear} />);
    fireEvent.click(screen.getByRole('button', { name: 'Feature' }));
    expect(onFeature).toHaveBeenCalledWith(m);
    rerender(<ChatPanel messages={[m]} featuredId={m.id} onFeature={onFeature} onClearFeature={onClear} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unfeature' }));
    expect(onClear).toHaveBeenCalled();
  });
});

describe('ChatPanel pausing', () => {
  const msg = (id: string, platform: 'twitch' | 'youtube' = 'twitch') =>
    chatMessage({ id, platform, text: id, fragments: [{ kind: 'text', text: id }] });
  const ids = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => msg(`twitch:${from + i}`));
  const props = { featuredId: null, onFeature: noop, onClearFeature: noop };

  function scrollTo(list: Element, scrollTop: number) {
    Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(list, 'scrollTop', { value: scrollTop, configurable: true, writable: true });
    fireEvent.scroll(list);
  }

  it('keeps counting new messages when the list is at its cap', () => {
    const { container, rerender } = render(<ChatPanel messages={ids(0, 300)} {...props} />);
    scrollTo(container.querySelector('ol')!, 0);
    rerender(<ChatPanel messages={ids(5, 305)} {...props} />);
    expect(screen.getByRole('button', { name: /Jump to latest/ }).textContent).toContain('5 new');
  });

  it('does not count messages from hidden platforms', () => {
    const { container, rerender } = render(<ChatPanel messages={[msg('twitch:1'), msg('youtube:1', 'youtube')]} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Twitch' }));
    scrollTo(container.querySelector('ol')!, 0);
    rerender(<ChatPanel messages={[msg('twitch:1'), msg('youtube:1', 'youtube'), msg('twitch:2'), msg('twitch:3'), msg('youtube:2', 'youtube')]} {...props} />);
    expect(screen.getByRole('button', { name: /Jump to latest/ }).textContent).toContain('1 new');
  });

  it('jump to latest re-pins and removes the button', () => {
    const { container, rerender } = render(<ChatPanel messages={ids(0, 3)} {...props} />);
    scrollTo(container.querySelector('ol')!, 0);
    rerender(<ChatPanel messages={ids(0, 4)} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /Jump to latest/ }));
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });
});

describe('isNearBottom', () => {
  it('is true within the threshold', () => {
    expect(isNearBottom({ scrollTop: 560, clientHeight: 400, scrollHeight: 1000 })).toBe(true);
    expect(isNearBottom({ scrollTop: 100, clientHeight: 400, scrollHeight: 1000 })).toBe(false);
  });
});
