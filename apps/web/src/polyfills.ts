// web3.js 1.x and spl-token reach for the Node `Buffer` global at module scope; the
// browser has none, and Vite does not add one. Imported first from `main.tsx`. The
// trailing slash picks the npm package over the Node builtin Vite would stub out;
// the package's type is a subset of Node's, hence the cast.
import { Buffer } from 'buffer/'

globalThis.Buffer ??= Buffer as unknown as typeof globalThis.Buffer
