import type { Driver } from './driver.js';
import { By } from './by.js';
import { Key } from './keys.js';
import { until } from './wait.js';

export type MouseButton = 'left' | 'middle' | 'right';
export type Point = { x: number; y: number };
export type Target = string | By | Point;

function toButtonCode(btn: MouseButton | undefined): number {
  if (btn === 'middle') return 1;
  if (btn === 'right') return 2;
  return 0;
}

export class MouseController {
  constructor(private driver: Driver) {}

  private async resolveElement(selector: string | By) {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    // Wait until element is attached and visible to improve click reliability
    const el = await this.driver.wait(until.elementIsVisible(by), { timeout: 5000 });
    return el;
  }

  async move(target: Target, options?: { durationMs?: number }): Promise<void> {
    const duration = options?.durationMs ?? 100;
    if (typeof target === 'string' || (target as By).using) {
      const el = await this.resolveElement(target as string | By);
      await this.driver.pointerMoveTo(el, undefined, undefined, duration);
    } else {
      const pt = target as Point;
      await this.driver.pointerMoveTo(undefined, pt.x, pt.y, duration);
    }
  }

  async down(button: MouseButton = 'left'): Promise<void> {
    await this.driver.mouseDown(toButtonCode(button));
  }

  async up(button: MouseButton = 'left'): Promise<void> {
    await this.driver.mouseUp(toButtonCode(button));
  }

  async click(
    target: Target,
    options?: { button?: MouseButton; clickCount?: number; modifiers?: Array<keyof typeof Key> }
  ): Promise<void> {
    const button = options?.button ?? 'left';
    const count = Math.max(1, options?.clickCount ?? 1);
    const modifiers = options?.modifiers ?? [];
    for (const k of modifiers) await this.driver.keyDownCode((Key as any)[k]);
    if (typeof target === 'string' || (target as By).using) {
      const el = await this.resolveElement(target as string | By);
      await this.driver.pointerClick(el, undefined, undefined, toButtonCode(button), count, 50);
    } else {
      const pt = target as Point;
      await this.driver.pointerClick(undefined, pt.x, pt.y, toButtonCode(button), count, 50);
    }
    for (const k of modifiers.slice().reverse()) await this.driver.keyUpCode((Key as any)[k]);
  }

  async dblclick(
    target: Target,
    options?: { button?: MouseButton; modifiers?: Array<keyof typeof Key> }
  ): Promise<void> {
    await this.click(target, {
      button: options?.button,
      clickCount: 2,
      modifiers: options?.modifiers,
    });
  }

  async dragAndDrop(
    from: Target,
    to: Target,
    options?: { durationMs?: number; modifiers?: Array<keyof typeof Key> }
  ): Promise<void> {
    const duration = options?.durationMs ?? 200;
    const modifiers = options?.modifiers ?? [];
    for (const k of modifiers) await this.driver.keyDownCode((Key as any)[k]);
    const resolve = async (t: Target) => {
      if (typeof t === 'string' || (t as By).using)
        return await this.resolveElement(t as string | By);
      return t as Point;
    };
    const src = await resolve(from);
    const dst = await resolve(to);
    if ('x' in src) {
      await this.driver.pointerMoveTo(undefined, src.x, src.y, 0);
    } else {
      await this.driver.pointerMoveTo(src as unknown as any, undefined, undefined, 0);
    }
    await this.driver.mouseDown(0);
    if ('x' in dst) {
      await this.driver.pointerMoveTo(undefined, dst.x, dst.y, duration);
    } else {
      await this.driver.pointerMoveTo(dst as unknown as any, undefined, undefined, duration);
    }
    await this.driver.mouseUp(0);
    for (const k of modifiers.slice().reverse()) await this.driver.keyUpCode((Key as any)[k]);
  }

  async wheel(deltaX: number, deltaY: number, target?: Target): Promise<void> {
    if (!target) {
      await this.driver.wheelScroll(deltaX, deltaY);
      return;
    }
    if (typeof target === 'string' || (target as By).using) {
      const el = await this.resolveElement(target as string | By);
      const [x, y] = await this.driver.executeScript<[number, number]>(
        `return (function(el){ const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)]; })(arguments[0]);`,
        [(el as any).toJSON()] as unknown as any[]
      );
      await this.driver.wheelScroll(deltaX, deltaY, x, y);
    } else {
      const pt = target as Point;
      await this.driver.wheelScroll(deltaX, deltaY, pt.x, pt.y);
    }
  }
}
