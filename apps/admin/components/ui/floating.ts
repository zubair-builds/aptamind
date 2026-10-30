'use client';

import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';

export type Placement = 'top' | 'bottom' | 'bottom-start' | 'bottom-end';

const GAP = 6;
const MARGIN = 8;

/** Fixed-position coordinates next to `anchor`, flipped and clamped to stay in the viewport. */
export function place(
  anchor: Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right' | 'width'>,
  size: { width: number; height: number },
  placement: Placement,
  viewport: { width: number; height: number },
) {
  let side: 'top' | 'bottom' = placement === 'top' ? 'top' : 'bottom';
  const fitsBelow = anchor.bottom + GAP + size.height <= viewport.height - MARGIN;
  const fitsAbove = anchor.top - GAP - size.height >= MARGIN;
  if (side === 'bottom' && !fitsBelow && fitsAbove) side = 'top';
  else if (side === 'top' && !fitsAbove && fitsBelow) side = 'bottom';
  // Fits on neither side (a tall panel on a phone): clamp into the viewport; the panel's own
  // max-height and scroll keep it usable.
  const raw = side === 'bottom' ? anchor.bottom + GAP : anchor.top - GAP - size.height;
  const top = Math.max(MARGIN, Math.min(raw, viewport.height - MARGIN - size.height));
  const preferred =
    placement === 'bottom-start'
      ? anchor.left
      : placement === 'bottom-end'
        ? anchor.right - size.width
        : anchor.left + anchor.width / 2 - size.width / 2;
  const left = Math.max(MARGIN, Math.min(preferred, viewport.width - MARGIN - size.width));
  return { top: Math.round(top), left: Math.round(left), side };
}

/**
 * Shows `floating` in the top layer (Popover API, when available) and keeps it positioned next
 * to `anchor` while open. The element must carry `popover="manual"`.
 *
 * `onShown` runs once the layer is visible and positioned (after `showPopover()`), which is the
 * earliest moment `.focus()` inside it works: a `[popover]` that is not yet open is
 * `display: none`, so focusing from a ref callback silently does nothing.
 */
export function useFloating(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  floating: RefObject<HTMLElement | null>,
  placement: Placement,
  onShown?: (el: HTMLElement) => void,
) {
  const shown = useRef(onShown);
  useLayoutEffect(() => {
    shown.current = onShown;
  });
  useLayoutEffect(() => {
    const el = floating.current;
    const target = anchor.current;
    if (!open || !el || !target) return;
    try {
      if (!el.matches(':popover-open')) el.showPopover?.();
    } catch {
      /* no Popover API support: stays in the normal flow, still positioned */
    }
    const update = () => {
      const r = el.getBoundingClientRect();
      const p = place(target.getBoundingClientRect(), r, placement, {
        width: window.innerWidth,
        height: window.innerHeight,
      });
      el.style.top = `${p.top}px`;
      el.style.left = `${p.left}px`;
      el.dataset.side = p.side;
    };
    update();
    shown.current?.(el);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, anchor, floating, placement]);
}

/*
 * Open layers, innermost last. One capture-phase Escape listener serves them all: only the top
 * layer handles Escape, and the event stops there (`stopImmediatePropagation` + default
 * prevented, so a surrounding native <dialog> does not also close). Layers register in a layout
 * effect, and a layer whose element contains another is kept below it: layers that open in the
 * same commit (child effects run first) still stack innermost-last. Otherwise the order is the
 * order they opened, independent of re-renders.
 */
interface Layer {
  escape: () => void;
  el: () => HTMLElement | null;
}
const layers: Layer[] = [];

function onLayerKey(e: KeyboardEvent) {
  // IME composition: Escape cancels the composition, not the layer.
  if (e.key !== 'Escape' || e.isComposing) return;
  const top = layers.at(-1);
  if (!top) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  top.escape();
}

function register(layer: Layer) {
  const el = layer.el();
  // Below the first open layer it contains (its descendant), else on top.
  const i = el
    ? layers.findIndex((l) => {
        const o = l.el();
        return !!o && o !== el && el.contains(o);
      })
    : -1;
  if (i < 0) layers.push(layer);
  else layers.splice(i, 0, layer);
  if (layers.length === 1) window.addEventListener('keydown', onLayerKey, true);
}

function unregister(layer: Layer) {
  const i = layers.indexOf(layer);
  if (i >= 0) layers.splice(i, 1);
  if (!layers.length) window.removeEventListener('keydown', onLayerKey, true);
}

/**
 * Registers an open layer on the Escape stack; `onEscape` runs when it is the top layer. `element`
 * is the layer's outermost element (anchor + panel), used to keep nested layers above their
 * container.
 */
export function useEscapeLayer(open: boolean, onEscape: () => void, element?: RefObject<HTMLElement | null>) {
  const handler = useRef(onEscape);
  useLayoutEffect(() => {
    handler.current = onEscape;
  });
  useLayoutEffect(() => {
    if (!open) return;
    const layer: Layer = { escape: () => handler.current(), el: () => element?.current ?? null };
    register(layer);
    return () => unregister(layer);
  }, [open, element]);
}

/*
 * Focus returned to a trigger after a layer closes should not pop that trigger's tooltip over the
 * row above (it is not a "user focused this" moment). Tooltips check this flag in their focus
 * handler, which runs synchronously inside `focus()`.
 */
let quietFocus = false;

/** Focuses `el` without showing its focus tooltip. */
export function focusQuietly(el: HTMLElement | null | undefined) {
  if (!el) return;
  quietFocus = true;
  try {
    el.focus();
  } finally {
    quietFocus = false;
  }
}

export const isQuietFocus = () => quietFocus;

/** Number of open layers (tests). */
export const openLayerCount = () => layers.length;

export type DismissReason = 'escape' | 'outside' | 'blur';

/**
 * Closes a floating layer on Escape (through the layer stack, so only the innermost closes), on
 * pointer down outside any of `inside`, and when focus moves outside them (`blur`).
 */
export function useDismiss(
  open: boolean,
  inside: Array<RefObject<HTMLElement | null>>,
  onDismiss: (reason: DismissReason) => void,
) {
  const latest = useRef({ inside, onDismiss });
  useLayoutEffect(() => {
    latest.current = { inside, onDismiss };
  });
  useEscapeLayer(open, () => latest.current.onDismiss('escape'), inside[0]);
  useEffect(() => {
    if (!open) return;
    const outside = (t: EventTarget | null) =>
      t instanceof Node && !latest.current.inside.some((r) => r.current?.contains(t));
    const onPointer = (e: PointerEvent) => {
      if (outside(e.target)) latest.current.onDismiss('outside');
    };
    const onFocus = (e: FocusEvent) => {
      if (outside(e.target)) latest.current.onDismiss('blur');
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('focusin', onFocus, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('focusin', onFocus, true);
    };
  }, [open]);
}
