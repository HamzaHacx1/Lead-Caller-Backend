// ESM named exports
let ioRef = null;

export function setIo(io) {
  ioRef = io;
}

export function emit(event, payload) {
  if (ioRef) ioRef.emit(event, payload);
}
