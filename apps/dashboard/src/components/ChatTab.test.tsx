// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatMessage } from '@streamhub/shared/testing';
import { ChatPanel, matchesQuery, normalizeQuery } from './ChatPanel';
import { ChatTab } from './ChatTab';

afterEach(cleanup);

const noop = () => {};
const say = (id: string, text: string, author = 'viewer', platform: 'twitch' | 'youtube' = 'twitch') =>
  chatMessage({ id, platform, text, fragments: [{ kind: 'text', text }], author: { id, name: author, roles: ['moderator'] } });
const messages = [say('twitch:1', 'first question'), say('youtube:1', 'Great show!', 'Ana', 'youtube'), say('twitch:2', 'another QUESTION', 'Bo')];

describe('ChatTab', () => {
  it('searches text and names, in any case', () => {
    render(<ChatTab messages={messages} featuredId={null} size="medium" onFeature={noop} onClearFeature={noop} />);
    const search = screen.getByRole('searchbox', { name: 'Search chat' });
    fireEvent.change(search, { target: { value: 'question' } });
    expect(screen.getByText('first question')).toBeTruthy();
    expect(screen.getByText('another QUESTION')).toBeTruthy();
    expect(screen.queryByText('Great show!')).toBeNull();
    fireEvent.change(search, { target: { value: 'ana' } });
    expect(screen.getByText('Great show!')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'nobody said this' } });
    expect(screen.getByText('No messages match.')).toBeTruthy();
  });

  it('combines the search with the platform chips', () => {
    render(<ChatTab messages={messages} featuredId={null} size="medium" onFeature={noop} onClearFeature={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Twitch' }));
    expect(screen.queryByText('first question')).toBeNull();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'show' } });
    expect(screen.getByText('Great show!')).toBeTruthy();
  });

  it('shows what is on screen and clears it', () => {
    const onClear = vi.fn();
    const { rerender } = render(<ChatTab messages={messages} featuredId={null} size="medium" onFeature={noop} onClearFeature={onClear} />);
    expect(screen.getByText(/Nothing on screen/)).toBeTruthy();
    rerender(<ChatTab messages={messages} featuredId="youtube:1" size="medium" onFeature={noop} onClearFeature={onClear} />);
    expect(screen.getByText('On screen now')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Take down' }));
    expect(onClear).toHaveBeenCalled();
    rerender(<ChatTab messages={messages} featuredId="twitch:gone" size="medium" onFeature={noop} onClearFeature={onClear} />);
    expect(screen.getByText('A message is on screen')).toBeTruthy();
  });

  it('renders extra tools next to the search', () => {
    render(<ChatTab messages={messages} featuredId={null} size="xlarge" tools={<button>Aa</button>} onFeature={noop} onClearFeature={noop} />);
    expect(screen.getByRole('button', { name: 'Aa' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Chat' }).className).toContain('size-xlarge');
  });

  it('applies the chat text size', () => {
    render(<ChatTab messages={messages} featuredId={null} size="large" onFeature={noop} onClearFeature={noop} />);
    expect(screen.getByRole('region', { name: 'Chat' }).className).toContain('size-large');
  });
});

describe('compact ChatPanel', () => {
  it('keeps the chips, short role badges and Feature', () => {
    const onFeature = vi.fn();
    render(<ChatPanel compact messages={messages} featuredId={null} onFeature={onFeature} onClearFeature={noop} />);
    expect(screen.getByRole('button', { name: 'Twitch' })).toBeTruthy();
    expect(screen.getAllByText('mod').length).toBe(3);
    fireEvent.click(screen.getAllByRole('button', { name: 'Feature' })[0]!);
    expect(onFeature).toHaveBeenCalledWith(messages[0]);
  });

  it('shows what is on screen in a footer with Take down', () => {
    const onClear = vi.fn();
    const { rerender } = render(<ChatPanel compact messages={messages} featuredId={null} onFeature={noop} onClearFeature={onClear} />);
    expect(screen.queryByRole('button', { name: 'Take down' })).toBeNull();
    rerender(<ChatPanel compact messages={messages} featuredId="youtube:1" onFeature={noop} onClearFeature={onClear} />);
    expect(screen.getByText("On screen: Ana's message")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Take down' }));
    expect(onClear).toHaveBeenCalled();
  });
});

describe('matchesQuery', () => {
  it('treats a blank query as everything, after one normalization', () => {
    expect(matchesQuery(messages[0]!, normalizeQuery('   '))).toBe(true);
    expect(matchesQuery(messages[0]!, normalizeQuery(' FIRST '))).toBe(true);
    expect(matchesQuery(messages[0]!, normalizeQuery('bo'))).toBe(false);
  });
});
