// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BoolBadge, StatusBadge, toneFor } from './Badge';

afterEach(cleanup);

describe('StatusBadge', () => {
  it('always carries its meaning as text, not only colour', () => {
    render(<StatusBadge value="VERIFIED_LIVE" />);
    const badge = screen.getByText('Verified live');
    expect(badge.className).toContain('badge-ok');
  });

  it('shows unknown for a missing tri-state value', () => {
    render(<BoolBadge value={null} />);
    expect(screen.getByText('unknown').className).toContain('badge-muted');
  });

  it('keeps unmapped values neutral', () => {
    expect(toneFor('something_new')).toBe('muted');
    expect(toneFor('high', 'confidence')).toBe('ok');
  });
});
