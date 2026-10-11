import { EventEmitter } from 'node:events';

export function createEvents() {
  const emitter = new EventEmitter();
  return {
    emit: (type, data = {}) => emitter.emit('event', { type, ...data, at: Date.now() }),
    on(fn) {
      emitter.on('event', fn);
      return () => emitter.off('event', fn);
    },
  };
}
