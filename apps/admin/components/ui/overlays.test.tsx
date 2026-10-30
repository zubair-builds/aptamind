// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { lazy, type ReactElement, type ReactNode, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, IconButton } from './Button';
import { Dialog } from './Dialog';
import { CopyButton } from './CopyButton';
import { openLayerCount, useEscapeLayer } from './floating';
import { Menu } from './Menu';
import { Popover } from './Popover';
import { Tabs } from './Tabs';
import { ToastProvider, useToast } from './Toast';
import { Tooltip } from './Tooltip';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const focused = () => document.activeElement;

describe('Tooltip', () => {
  it('describes its trigger, appears on hover after a delay and hides on Escape', () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="Runs the workflow once">
        <button type="button">Run</button>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: 'Run' });
    const describedBy = button.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)?.textContent).toBe('Runs the workflow once');
    fireEvent.pointerEnter(button.parentElement!);
    expect(document.querySelector('[popover]')).toBeNull();
    act(() => vi.advanceTimersByTime(400));
    expect(document.querySelector('[popover]')?.textContent).toBe('Runs the workflow once');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('[popover]')).toBeNull();
    expect(openLayerCount()).toBe(0);
  });

  it('refuses a child that is not an element with a clear error', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notAnElement = lazy(async () => ({ default: Button })) as unknown as ReactElement<object>;
    expect(() => render(<Tooltip content="x">{notAnElement}</Tooltip>)).toThrow(
      /children` must be an element created in a client component/,
    );
    quiet.mockRestore();
  });
});

describe('Popover', () => {
  it('opens a labelled panel, moves focus in and returns it on Escape', () => {
    render(
      <Popover label="Provenance" trigger={<Button>2 sources</Button>}>
        <a href="/observations/obs_1">Observation</a>
      </Popover>,
    );
    const trigger = screen.getByRole('button', { name: '2 sources' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    const panel = screen.getByRole('dialog', { name: 'Provenance' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(panel.id);
    expect(focused()).toBe(screen.getByRole('link', { name: 'Observation' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(focused()).toBe(trigger);
  });

  it('refuses a trigger that is not an element (a lazy server reference) with a clear error', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notAnElement = lazy(async () => ({ default: Button })) as unknown as ReactElement<object>;
    expect(() =>
      render(
        <Popover label="Provenance" trigger={notAnElement}>
          x
        </Popover>,
      ),
    ).toThrow(/trigger` must be an element created in a client component/);
    quiet.mockRestore();
  });

  it('closes when focus moves outside the trigger and panel', () => {
    render(
      <>
        <Popover label="Details" trigger={<Button>More</Button>}>
          <a href="/x">Inside</a>
        </Popover>
        <button type="button">Elsewhere</button>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    act(() => screen.getByRole('link', { name: 'Inside' }).focus());
    expect(screen.getByRole('dialog')).toBeTruthy();
    act(() => screen.getByRole('button', { name: 'Elsewhere' }).focus());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('nested: Escape closes only the innermost layer, whatever the render order', () => {
    function Nested() {
      const [n, setN] = useState(0);
      return (
        <Popover label="Outer" trigger={<Button>Outer</Button>}>
          <Button onClick={() => setN(n + 1)}>Re-render {n}</Button>
          <Popover label="Inner" trigger={<Button>Inner</Button>}>
            <a href="/inner">Inner link</a>
          </Popover>
        </Popover>
      );
    }
    render(<Nested />);
    fireEvent.click(screen.getByRole('button', { name: 'Outer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Inner' }));
    // Re-render the outer layer after the inner opened: the inner must stay on top.
    fireEvent.click(screen.getByRole('button', { name: /Re-render/ }));
    expect(screen.getByRole('button', { name: 'Re-render 1' })).toBeTruthy();
    act(() => screen.getByRole('link', { name: 'Inner link' }).focus());
    expect(screen.getByRole('dialog', { name: 'Inner' })).toBeTruthy();
    expect(openLayerCount()).toBe(2);
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      document.activeElement!.dispatchEvent(esc);
    });
    expect(esc.defaultPrevented).toBe(true);
    expect(screen.queryByRole('dialog', { name: 'Inner' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Outer' })).toBeTruthy();
    expect(focused()).toBe(screen.getByRole('button', { name: 'Inner' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Outer' })).toBeNull();
    expect(focused()).toBe(screen.getByRole('button', { name: 'Outer' }));
    expect(openLayerCount()).toBe(0);
  });

  it('inside a Dialog: Escape closes the popover and is consumed, so the dialog stays open', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Edit">
        <Popover label="Provenance" trigger={<Button>2 sources</Button>}>
          <a href="/o">Observation</a>
        </Popover>
        <Tooltip content="Hint">
          <button type="button">Hinted</button>
        </Tooltip>
      </Dialog>,
    );
    fireEvent.click(screen.getByRole('button', { name: '2 sources' }));
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      document.activeElement!.dispatchEvent(esc);
    });
    expect(esc.defaultPrevented).toBe(true); // a native <dialog> ignores a prevented Escape
    expect(screen.queryByRole('dialog', { name: 'Provenance' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('dialog')!.open).toBe(true);
  });

  it('closes on a pointer down outside', () => {
    render(
      <>
        <p>outside</p>
        <Popover label="Details" trigger={<Button>More</Button>}>
          text
        </Popover>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.pointerDown(screen.getByText('outside'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Menu', () => {
  const setup = () => {
    const onCopy = vi.fn();
    render(
      <Menu
        label="Record actions"
        items={[
          { label: 'Copy id', onSelect: onCopy },
          { label: 'Copy link' },
          { label: 'Open raw JSON', disabled: true },
          'separator',
          { label: 'Disable source', danger: true },
        ]}
      />,
    );
    return { onCopy, button: screen.getByRole('button', { name: 'Record actions' }) };
  };

  it('opens on the first item and moves with arrows, Home/End and type-ahead', () => {
    const { button } = setup();
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(button);
    expect(screen.getByRole('menu', { name: 'Record actions' })).toBeTruthy();
    expect(focused()?.textContent).toBe('Copy id');
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(focused()?.textContent).toBe('Copy link');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(focused()?.textContent).toBe('Disable source'); // disabled item skipped
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(focused()?.textContent).toBe('Copy id'); // wraps
    fireEvent.keyDown(menu, { key: 'End' });
    expect(focused()?.textContent).toBe('Disable source');
    fireEvent.keyDown(menu, { key: 'c' });
    expect(focused()?.textContent).toBe('Copy id');
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(focused()?.textContent).toBe('Copy id');
  });

  it('keeps the shortcut hint out of the item name', () => {
    render(
      <Menu
        label="Actions"
        items={[
          { label: 'Copy id', shortcut: 'c i' },
          { label: 'Save', shortcut: 's' },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    const copy = screen.getByRole('menuitem', { name: 'Copy id' });
    expect(copy.getAttribute('aria-keyshortcuts')).toBeNull(); // a sequence is not a chord
    expect(copy.getAttribute('aria-description')).toBe('Shortcut: c then i');
    expect(screen.getByRole('menuitem', { name: 'Save' }).getAttribute('aria-keyshortcuts')).toBe('s');
  });

  it('ignores Ctrl/Meta chords in type-ahead', () => {
    const { button } = setup();
    fireEvent.click(button);
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'End' });
    fireEvent.keyDown(menu, { key: 'c', ctrlKey: true });
    fireEvent.keyDown(menu, { key: 'c', metaKey: true });
    expect(focused()?.textContent).toBe('Disable source');
  });

  it('closes when focus leaves the menu and its button', () => {
    const { button } = setup();
    const outside = document.createElement('button');
    document.body.append(outside);
    fireEvent.click(button);
    act(() => outside.focus());
    expect(screen.queryByRole('menu')).toBeNull();
    outside.remove();
  });

  it('opens on the last item with ArrowUp', () => {
    const { button } = setup();
    fireEvent.keyDown(button, { key: 'ArrowUp' });
    expect(focused()?.textContent).toBe('Disable source');
  });

  it('runs the chosen item, closes and returns focus to the button', () => {
    const { button, onCopy } = setup();
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy id' }));
    expect(onCopy).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(focused()).toBe(button);
  });

  it('closes on Escape without running anything', () => {
    const { button, onCopy } = setup();
    fireEvent.click(button);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onCopy).not.toHaveBeenCalled();
    expect(focused()).toBe(button);
  });

  it('does not run disabled items', () => {
    const { button } = setup();
    fireEvent.click(button);
    const item = screen.getByRole('menuitem', { name: 'Open raw JSON' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(item);
    expect(screen.getByRole('menu')).toBeTruthy();
  });
});

describe('Quiet focus return', () => {
  it('focus handed back after Escape does not pop the trigger tooltip over the row above', () => {
    vi.useFakeTimers();
    render(
      <Popover label="Preview" trigger={<IconButton icon="eye" label="Preview row" />}>
        <a href="/x">Inside</a>
      </Popover>,
    );
    const trigger = screen.getByRole('button', { name: 'Preview row' });
    fireEvent.click(trigger);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
    act(() => vi.advanceTimersByTime(500));
    expect(document.querySelector('[popover]')).toBeNull(); // no tooltip
  });
});

describe('Escape layer stack', () => {
  function Layer({
    name,
    onEscape,
    children,
  }: {
    name: string;
    onEscape: (n: string) => void;
    children?: ReactNode;
  }) {
    const ref = useRef<HTMLDivElement>(null);
    useEscapeLayer(true, () => onEscape(name), ref);
    return (
      <div ref={ref} data-layer={name}>
        {children}
      </div>
    );
  }

  it('layers opened in the same commit stack innermost-last (child effects run first)', () => {
    const closed: string[] = [];
    render(
      <Layer name="outer" onEscape={(n) => closed.push(n)}>
        <Layer name="inner" onEscape={(n) => closed.push(n)} />
      </Layer>,
    );
    expect(openLayerCount()).toBe(2);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(closed).toEqual(['inner']);
  });

  it('a handled Escape stops there: no later keydown listener sees it', () => {
    const spy = vi.fn();
    document.addEventListener('keydown', spy);
    render(
      <Popover label="Details" trigger={<Button>More</Button>}>
        <a href="/x">Inside</a>
      </Popover>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(spy).not.toHaveBeenCalled(); // fails without stopImmediatePropagation
    // With no open layer, Escape reaches the page as usual.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(spy).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', spy);
  });

  it('Escape during IME composition is left to the IME', () => {
    render(
      <Popover label="Details" trigger={<Button>More</Button>}>
        <a href="/x">Inside</a>
      </Popover>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', isComposing: true });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('CopyButton inside a Popover (Clipboard API missing)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('the fallback keeps focus in the layer and returns it to the button', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn().mockReturnValue(true),
      configurable: true,
    });
    // Browser-like select(): it focuses the textarea.
    const select = vi.spyOn(HTMLTextAreaElement.prototype, 'select').mockImplementation(function (
      this: HTMLTextAreaElement,
    ) {
      this.focus();
    });
    render(
      <Popover label="Record" trigger={<Button>Open</Button>}>
        <CopyButton value="job_1" label="Copy id" />
      </Popover>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const copy = screen.getByRole('button', { name: 'Copy id' });
    act(() => copy.focus());
    await act(async () => {
      fireEvent.click(copy);
    });
    expect(select).toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Record' })).toBeTruthy(); // not closed by focusin
    expect(document.activeElement).toBe(copy);
    expect(document.querySelector('textarea')).toBeNull();
    select.mockRestore();
  });
});

describe('Dialog', () => {
  function Harness({ onClose }: { onClose: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open</Button>
        <Dialog
          open={open}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          title="Disable source?"
          description="Scheduled refreshes stop."
        >
          body
        </Dialog>
      </>
    );
  }

  it('opens modally with a labelled, described dialog and closes via its button or Escape', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = document.querySelector('dialog')!;
    expect(dialog.open).toBe(true);
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'Disable source?',
    );
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Scheduled refreshes stop.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog.open).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const cancel = new Event('cancel', { cancelable: true });
    act(() => {
      dialog.dispatchEvent(cancel);
    });
    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('reports a native close it did not request, but not its own', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = document.querySelector('dialog')!;
    act(() => {
      dialog.close(); // e.g. Chrome closing on a repeated Escape without a cancel event
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(onClose).toHaveBeenCalledTimes(2); // the button, not also the resulting close event
  });

  it('closes on a backdrop click, but not when a drag started inside the content', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = document.querySelector('dialog')!;
    fireEvent.pointerDown(screen.getByText('body'));
    fireEvent.click(dialog); // mouseup landed on the backdrop after selecting text
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(dialog);
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Tabs', () => {
  const tabs = [
    { id: 'overview', label: 'Overview', content: 'Overview panel' },
    { id: 'evidence', label: 'Evidence', count: 12, content: 'Evidence panel' },
    { id: 'debug', label: 'Debug', content: 'Debug panel' },
  ];

  it('has one tab stop and selects with arrow keys, Home and End', () => {
    const onChange = vi.fn();
    render(<Tabs label="Record sections" tabs={tabs} onChange={onChange} />);
    const [overview, evidence, debug] = screen.getAllByRole('tab');
    expect(overview!.getAttribute('aria-selected')).toBe('true');
    expect([overview, evidence, debug].map((t) => t!.tabIndex)).toEqual([0, -1, -1]);
    expect(screen.getByRole('tabpanel', { name: 'Overview' }).textContent).toBe('Overview panel');
    fireEvent.keyDown(overview!, { key: 'ArrowRight' });
    expect(evidence!.getAttribute('aria-selected')).toBe('true');
    expect(focused()).toBe(evidence);
    expect(onChange).toHaveBeenLastCalledWith('evidence');
    fireEvent.keyDown(evidence!, { key: 'End' });
    expect(debug!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(debug!, { key: 'ArrowRight' });
    expect(overview!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(overview!, { key: 'ArrowLeft' });
    expect(screen.getByRole('tabpanel').textContent).toBe('Debug panel');
  });

  it('every aria-controls points at a panel that exists; only the selected one is visible', () => {
    render(<Tabs label="Record sections" tabs={tabs} />);
    for (const tab of screen.getAllByRole('tab')) {
      const panel = document.getElementById(tab.getAttribute('aria-controls')!);
      expect(panel?.getAttribute('role')).toBe('tabpanel');
      expect(panel!.hidden).toBe(tab.getAttribute('aria-selected') !== 'true');
    }
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1); // hidden panels are not exposed
  });
});

describe('Toast', () => {
  function Trigger() {
    const toast = useToast();
    return (
      <Button onClick={() => toast({ message: 'Run started', href: '/runs/run_1', hrefLabel: 'View run' })}>
        Go
      </Button>
    );
  }

  it('announces results politely with a link and dismisses itself', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    const status = screen.getByRole('status');
    // role=status alone (implicitly polite); the live text is the message only.
    expect(status.getAttribute('aria-live')).toBeNull();
    expect(status.textContent).toBe('Run started. ');
    expect(status.contains(screen.getByRole('button', { name: 'Dismiss notification' }))).toBe(false);
    expect(screen.getByRole('link', { name: 'View run' }).getAttribute('href')).toBe('/runs/run_1');
    act(() => vi.advanceTimersByTime(6000));
    expect(status.textContent).toBe('');
  });

  it('can be dismissed manually', () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.getByRole('status').textContent).toBe('');
  });
});
