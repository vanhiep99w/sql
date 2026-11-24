import type { Frame } from './trace';
import styles from './btree-animation.module.css';

const easing = 'cubic-bezier(.22,1,.36,1)';

type Box = { left: number; top: number; width: number; height: number };

function snapshotLocalBoxes(container: HTMLElement | null, selector: string, attr: string) {
  const map = new Map<string, Box>();
  if (!container) return map;
  const origin = container.getBoundingClientRect();
  for (const el of container.querySelectorAll<HTMLElement>(selector)) {
    const id = el.getAttribute(attr);
    if (!id) continue;
    const r = el.getBoundingClientRect();
    map.set(id, { left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height });
  }
  return map;
}

export type TransitionCallbacks = {
  onHeightAnimating?: (active: boolean) => void;
};

// Snapshot the old layout before React commits, then animate nodes, keys, edges and height smoothly.
export function captureTransition(
  root: HTMLElement,
  previous: Frame,
  next: Frame,
  direction: 'forward' | 'backward' = 'forward',
  callbacks?: TransitionCallbacks,
) {
  const viewport = root.querySelector<HTMLElement>('[data-tree-viewport]');
  const oldViewportHeight = viewport?.getBoundingClientRect().height ?? 0;
  const oldNodes = snapshotLocalBoxes(viewport, '[data-node]', 'data-node');
  const oldKeys = snapshotLocalBoxes(viewport, '[data-key-id]', 'data-key-id');

  const moves = direction === 'forward' ? (next.flyMoves ?? []) : [];
  const flySources = new Map<string, DOMRect>();
  for (const move of moves) {
    const el = root.querySelector<HTMLElement>(move.fromAttr);
    if (el) flySources.set(move.fromAttr, el.getBoundingClientRect());
  }

  return (layer: HTMLDivElement) => {
    const animations: Animation[] = [];
    const sprites = new Set<HTMLElement>();
    const origin = layer.getBoundingClientRect();

    // 1. Measure ALL new layout boxes BEFORE applying any transforms.
    const nextViewport = root.querySelector<HTMLElement>('[data-tree-viewport]');
    const nextVpRect = nextViewport?.getBoundingClientRect();
    const newViewportHeight = nextVpRect?.height ?? 0;

    const newNodeEls = new Map<string, HTMLElement>();
    const newNodes = new Map<string, Box>();
    const newScreenNodes = new Map<string, DOMRect>();
    if (nextViewport && nextVpRect) {
      for (const el of nextViewport.querySelectorAll<HTMLElement>('[data-node]')) {
        const id = el.getAttribute('data-node');
        if (!id) continue;
        const r = el.getBoundingClientRect();
        newNodeEls.set(id, el);
        newScreenNodes.set(id, r);
        newNodes.set(id, { left: r.left - nextVpRect.left, top: r.top - nextVpRect.top, width: r.width, height: r.height });
      }
    }

    const newKeyEls = new Map<string, HTMLElement>();
    const newKeys = new Map<string, Box>();
    if (nextViewport && nextVpRect) {
      for (const el of nextViewport.querySelectorAll<HTMLElement>('[data-key-id]')) {
        const id = el.getAttribute('data-key-id');
        if (!id) continue;
        const r = el.getBoundingClientRect();
        newKeyEls.set(id, el);
        newKeys.set(id, { left: r.left - nextVpRect.left, top: r.top - nextVpRect.top, width: r.width, height: r.height });
      }
    }

    const flyTargets = new Map<string, { el: HTMLElement; rect: DOMRect }>();
    for (const move of moves) {
      const el = root.querySelector<HTMLElement>(move.toAttr);
      if (el) flyTargets.set(move.toAttr, { el, rect: el.getBoundingClientRect() });
    }

    const spawnMap = direction === 'forward' ? (next.spawnFrom ?? {}) : {};
    const nodeDelta = new Map<string, { dx: number; dy: number }>();
    let hasStructuralMove = false;

    // 2. Smoothly animate tree viewport height when adding/removing a level (e.g. Root Split 2 -> 3 levels).
    let heightAnimActive = false;
    if (nextViewport && oldViewportHeight > 0 && Math.abs(oldViewportHeight - newViewportHeight) > 2) {
      hasStructuralMove = true;
      heightAnimActive = true;
      callbacks?.onHeightAnimating?.(true);
      const heightAnim = nextViewport.animate(
        [
          { height: `${oldViewportHeight}px`, overflow: 'hidden' },
          { height: `${newViewportHeight}px`, overflow: 'hidden' },
        ],
        { duration: 480, easing },
      );
      const finishHeight = () => {
        if (!heightAnimActive) return;
        heightAnimActive = false;
        callbacks?.onHeightAnimating?.(false);
      };
      heightAnim.onfinish = finishHeight;
      heightAnim.oncancel = finishHeight;
      animations.push(heightAnim);
    }

    // 3. FLIP every persistent node + glide newly split nodes out from their origin node.
    for (const [id, el] of newNodeEls) {
      const end = newNodes.get(id)!;
      const old = oldNodes.get(id);
      if (old) {
        const dx = old.left - end.left;
        const dy = old.top - end.top;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          hasStructuralMove = true;
          nodeDelta.set(id, { dx, dy });
          animations.push(
            el.animate(
              [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
              { duration: 480, easing },
            ),
          );
        }
        continue;
      }

      const originId = spawnMap[id];
      const spawnRect = originId ? oldNodes.get(originId) : undefined;
      if (spawnRect) {
        hasStructuralMove = true;
        const dx = (spawnRect.left + spawnRect.width / 2) - (end.left + end.width / 2);
        const dy = (spawnRect.top + spawnRect.height / 2) - (end.top + end.height / 2);
        animations.push(
          el.animate(
            [
              { transform: `translate(${dx}px, ${dy}px) scale(0.9)`, opacity: 0.2 },
              { opacity: 1, offset: 0.28 },
              { transform: 'none', opacity: 1 },
            ],
            { duration: 480, easing },
          ),
        );
      } else {
        hasStructuralMove = true;
        animations.push(
          el.animate(
            [{ transform: 'scale(0.92)', opacity: 0 }, { transform: 'none', opacity: 1 }],
            { duration: 360, easing },
          ),
        );
      }
    }

    // 4. FLIP persistent keys inside the same node (parent-compensated so keys never double-shift).
    for (const [keyId, el] of newKeyEls) {
      const old = oldKeys.get(keyId);
      if (!old) continue;
      const end = newKeys.get(keyId)!;
      const nodeId = keyId.split(':')[0];
      const parent = nodeDelta.get(nodeId) ?? { dx: 0, dy: 0 };
      const dx = (old.left - end.left) - parent.dx;
      const dy = (old.top - end.top) - parent.dy;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        animations.push(
          el.animate(
            [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
            { duration: 420, easing },
          ),
        );
      }
    }

    // 5. Cross-zone / migration flying key sprites (incoming insert, split transfer, promote, result match).
    let delay = 0;
    for (const move of moves) {
      const from = flySources.get(move.fromAttr);
      const targetInfo = flyTargets.get(move.toAttr);
      if (!from?.height || !targetInfo) continue;
      const { el: target, rect: end } = targetInfo;
      if (!end.height || [from, end].some((rect) => rect.bottom < 0 || rect.top > innerHeight)) continue;
      const dx = end.left - from.left;
      const dy = end.top - from.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;

      const sprite = target.cloneNode(true) as HTMLElement;
      sprite.removeAttribute('data-key-id');
      sprite.removeAttribute('data-result-key');
      sprite.classList.add(styles.flyer);
      sprite.dataset.flyTarget = move.toAttr;
      Object.assign(sprite.style, {
        left: `${from.left - origin.left}px`,
        top: `${from.top - origin.top}px`,
        width: `${end.width}px`,
        height: `${end.height}px`,
      });
      layer.append(sprite);
      sprites.add(sprite);

      const route = sprite.animate(
        [
          { opacity: 0.2, transform: 'scale(.92)' },
          { opacity: 1, offset: 0.14 },
          { opacity: 1, transform: `translate(${dx}px, ${dy}px)` },
        ],
        { duration: 440, delay, easing, fill: 'backwards' },
      );
      route.onfinish = () => {
        sprite.remove();
        sprites.delete(sprite);
      };
      animations.push(
        route,
        target.animate(
          [{ opacity: 0.15 }, { opacity: 1 }],
          { duration: 150, delay: delay + 320, fill: 'backwards' },
        ),
      );
      delay = Math.min(delay + 60, 180);
    }

    // 6. SVG edge choreography: fade edges in cleanly after structural glides, or trace newly active edges.
    const svgLayer = root.querySelector<SVGSVGElement>('[data-svg-layer]');
    if (svgLayer) {
      if (hasStructuralMove) {
        animations.push(
          svgLayer.animate(
            [{ opacity: 0 }, { opacity: 0, offset: 0.45 }, { opacity: 1 }],
            { duration: 520, easing },
          ),
        );
      } else if (direction === 'forward') {
        const prevActiveEdges = new Set(
          previous.edges.filter((e) => e.active).map((e) => `${e.from}-${e.to}-${e.branchIndex}`),
        );
        for (const edge of next.edges) {
          const edgeKey = `${edge.from}-${edge.to}-${edge.branchIndex}`;
          if (!edge.active || prevActiveEdges.has(edgeKey)) continue;
          const path = svgLayer.querySelector<SVGPathElement>(`[data-edge-key="${edgeKey}"]`);
          if (!path || typeof path.getTotalLength !== 'function') continue;
          const len = path.getTotalLength();
          if (len > 0) {
            animations.push(
              path.animate(
                [
                  { strokeDasharray: `${len} ${len}`, strokeDashoffset: `${len}` },
                  { strokeDasharray: `${len} ${len}`, strokeDashoffset: '0' },
                ],
                { duration: 380, easing },
              ),
            );
          }
        }
      }
    }

    // 7. Traveling glow across newly activated sibling links (e.g. Range Scan Leaf B -> Leaf C).
    if (direction === 'forward' && !hasStructuralMove) {
      const prevSiblings = new Set(
        previous.siblingLinks.filter((s) => s.active).map((s) => `${s.from}->${s.to}`),
      );
      for (const link of next.siblingLinks) {
        const key = `${link.from}->${link.to}`;
        if (!link.active || prevSiblings.has(key)) continue;
        const fromRect = newScreenNodes.get(link.from);
        const toRect = newScreenNodes.get(link.to);
        if (!fromRect || !toRect) continue;
        const pulse = document.createElement('span');
        pulse.className = styles.siblingPulse;
        pulse.dataset.siblingPulse = `${link.from}-${link.to}`;
        const startX = fromRect.right - origin.left - 4;
        const startY = fromRect.top + fromRect.height / 2 - origin.top - 5;
        const dx = (toRect.left - origin.left + 4) - startX;
        const dy = (toRect.top + toRect.height / 2 - origin.top - 5) - startY;
        Object.assign(pulse.style, { left: `${startX}px`, top: `${startY}px` });
        layer.append(pulse);
        sprites.add(pulse);
        const travel = pulse.animate(
          [
            { opacity: 0, transform: 'scale(0.6)' },
            { opacity: 1, offset: 0.2 },
            { opacity: 1, offset: 0.8, transform: `translate(${dx * 0.85}px, ${dy * 0.85}px) scale(1.15)` },
            { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(0.7)` },
          ],
          { duration: 420, easing },
        );
        travel.onfinish = () => {
          pulse.remove();
          sprites.delete(pulse);
        };
        animations.push(travel);
      }
    }

    return () => {
      for (const animation of animations) animation.cancel();
      for (const sprite of sprites) sprite.remove();
      if (heightAnimActive) {
        heightAnimActive = false;
        callbacks?.onHeightAnimating?.(false);
      }
    };
  };
}
