import type { Driver } from './driver.js';
import type { WebElement } from './webelement.js';

export type KeyStep = { type: 'keyDown' | 'keyUp'; value: string };
export type PointerStep =
  | {
      type: 'pointerMove';
      x: number;
      y: number;
      duration?: number;
      origin?: 'viewport' | WebElement;
    }
  | { type: 'pointerDown' | 'pointerUp'; button?: number }
  | { type: 'pause'; duration?: number };
export type WheelStep = {
  type: 'scroll';
  x?: number;
  y?: number;
  deltaX: number;
  deltaY: number;
  duration?: number;
};

export class ActionsBuilder {
  private keyActions: KeyStep[] = [];
  private pointerActions: PointerStep[] = [];
  private wheelActions: WheelStep[] = [];

  constructor(private driver: Driver) {}

  keyDown(value: string) {
    this.keyActions.push({ type: 'keyDown', value });
    return this;
  }
  keyUp(value: string) {
    this.keyActions.push({ type: 'keyUp', value });
    return this;
  }

  pointerMove(
    x: number,
    y: number,
    options?: { duration?: number; origin?: 'viewport' | WebElement }
  ) {
    this.pointerActions.push({
      type: 'pointerMove',
      x,
      y,
      duration: options?.duration,
      origin: options?.origin,
    });
    return this;
  }
  pointerDown(button: number = 0) {
    this.pointerActions.push({ type: 'pointerDown', button });
    return this;
  }
  pointerUp(button: number = 0) {
    this.pointerActions.push({ type: 'pointerUp', button });
    return this;
  }
  pause(duration?: number) {
    this.pointerActions.push({ type: 'pause', duration });
    return this;
  }

  wheel(deltaX: number, deltaY: number, options?: { x?: number; y?: number; duration?: number }) {
    this.wheelActions.push({
      type: 'scroll',
      x: options?.x,
      y: options?.y,
      deltaX,
      deltaY,
      duration: options?.duration,
    });
    return this;
  }

  async perform(): Promise<void> {
    const actions: any[] = [];
    if (this.keyActions.length)
      actions.push({ type: 'key', id: 'keyboard', actions: this.keyActions });
    if (this.pointerActions.length)
      actions.push({
        type: 'pointer',
        id: 'mouse',
        parameters: { pointerType: 'mouse' },
        actions: this.pointerActions,
      });
    if (this.wheelActions.length)
      actions.push({ type: 'wheel', id: 'wheel', actions: this.wheelActions });
    if (!actions.length) return;
    const send = (this.driver as any).__sendActions as ((a: any[]) => Promise<void>) | undefined;
    if (!send) throw new Error('Driver does not support combined actions');
    await send(actions);
  }
}
