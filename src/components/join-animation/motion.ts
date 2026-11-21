import { pairId, type Frame } from './trace';
import styles from './join-animation.module.css';

function rowsIn(root: HTMLElement, zone: string) {
  return new Map(Array.from(root.querySelectorAll<HTMLElement>(`[data-zone="${zone}"] [data-row]`),
    (node) => [node.dataset.row!, node]));
}

function rectsIn(root: HTMLElement, zone: string) {
  return new Map(Array.from(rowsIn(root, zone), ([id, node]) => [id, node.getBoundingClientRect()]));
}

const easing = 'cubic-bezier(.22,1,.36,1)';

// Snapshot the old layout before React commits, then animate towards the new layout.
export function captureTransition(root: HTMLElement, previous: Frame, next: Frame) {
  const source = rectsIn(root, 'inputs');
  const bank = rectsIn(root, 'bank');
  const gate = root.querySelector('[data-gate]')?.getBoundingClientRect();
  return (layer: HTMLDivElement) => {
    const animations: Animation[] = [];
    const sprites = new Set<HTMLElement>();
    const origin = layer.getBoundingClientRect();
    function fly(from: DOMRect | undefined, target: HTMLElement | undefined, delay = 0) {
      if (!from?.height || !target) return;
      const end = target.getBoundingClientRect();
      if (!end.height || [from, end].some((rect) => rect.bottom < 0 || rect.top > innerHeight)) return;
      const sprite = target.cloneNode(true) as HTMLElement;
      sprite.classList.add(styles.flyer);
      Object.assign(sprite.style, { left: `${from.left - origin.left}px`, top: `${from.top - origin.top}px`, width: `${end.width}px` });
      layer.append(sprite);
      sprites.add(sprite);
      const movement = `translate(${end.left - from.left}px, ${end.top - from.top}px)`;
      const route = sprite.animate([{ opacity: 0, transform: 'scale(.92)' }, { opacity: 1, offset: .13 },
        { opacity: 1, transform: movement }], { duration: 420, delay, easing, fill: 'backwards' });
      route.onfinish = () => { sprite.remove(); sprites.delete(sprite); };
      animations.push(route, target.animate([{ opacity: .15 }, { opacity: 1 }],
        { duration: 150, delay: delay + 310, fill: 'backwards' }));
    }

    if (next.sorted !== previous.sorted) {
      for (const [id, node] of rowsIn(root, 'inputs')) {
        const before = source.get(id);
        if (!before) continue;
        const dy = before.top - node.getBoundingClientRect().top;
        if (dy) animations.push(node.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }],
          { duration: 500, easing }));
      }
    }
    if (next.build) fly(source.get(next.build.id), rowsIn(root, 'bank').get(next.build.id));
    let delay = 0;
    for (const side of ['left', 'right'] as const) {
      for (const [id, node] of rowsIn(root, side)) {
        if (previous[side]?.some((row) => row.id === id)) continue;
        fly(bank.get(id) ?? source.get(id), node, delay);
        delay = Math.min(delay + 60, 180);
      }
    }
    if (next.pair) fly(gate, rowsIn(root, 'output').get(pairId(next.pair)));

    return () => {
      for (const animation of animations) animation.cancel();
      for (const sprite of sprites) sprite.remove();
    };
  };
}
